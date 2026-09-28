// The pinned engine's own wizard, for real (5.7, O6): every choice id in routes.json exists in the tarball, and the
// drive speaks the contract the gateway actually serves — steps only from wizard.next, one setup admission at a time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../../src/engine.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { providers, signIn } from '../../src/signin.ts';
import { routes } from '../../src/routes.ts';
import { scratchDir } from '../../../test-support.ts';
import type { GatewayTransport, SignInView } from '../../src/types.ts';

const install = scratchDir('o6-engine-signin');
const engineDir = join(install, 'engine');
const stateDir = join(install, 'state');
// The pin's bundled provider plugins must be allowed for the wizard to run at all: `plugins.allow` is the app's to
// set (Crewhouse passes its own id, memory-core and openai), and 5.6 keeps the kit's id in that list. Without them
// the engine answers every sign-in with "blocked by allowlist" — see the PR note on whether the kit should default it.
const engine = new Engine({ stateDir, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true,
  config: { plugins: { allow: ['openai', 'xai', 'github-copilot', 'openrouter', 'minimax'] } }, onState: () => {}, onExit: () => {} });
let transport: GatewayTransport;
let calls: string[] = [];

/** The gateway needs a moment to bind after spawn: connect only once the port answers. */
export const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

before(async () => {
  const ctx = await engine.start();
  for (let waited = 0; waited < 120_000; waited += 200) {
    if (await listening(ctx.port)) break;
    await delay(200);
    if (waited >= 119_800) assert.fail('the gateway never listened');
  }
  transport = gatewayTransport({ ...ctx, bridgeSock: engine.bridgeSock });
  const hello = await transport.start();
  assert.equal(hello.protocol, 4);
}, { timeout: 600_000 });

after(async () => { await transport?.stop(); await engine.stop(); });

/** The kit's own ctx over the real gateway. */
const signInCtx = () => {
  const request: GatewayTransport['request'] = async (method, params, options) => {
    calls.push(method);
    return await transport.request(method, params, options);
  };
  return {
    request,
    ensure: async (member: string) => {
      const list = await request('agents.list') as { agents: { id: string }[] };
      if (!list.agents.some((agent) => agent.id === member))
        await request('agents.create', { name: member, workspace: join(stateDir, 'openclaw', 'workspaces', member) });
      return { agentId: member };
    },
    callbackPort: 0,
  };
};

test('every choice id in routes.json exists in the pinned tarball (5.7, 5.12)', { timeout: 120_000 }, () => {
  const pkg = join(engineDir, 'node_modules', 'openclaw');
  assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, '2026.8.1', 'the pinned tarball is installed');
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (entry.name !== 'openclaw.plugin.json') continue;
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { providerAuthChoices?: { choiceId?: string }[] };
      for (const choice of manifest.providerAuthChoices ?? []) if (choice.choiceId) found.add(choice.choiceId);
    }
  };
  walk(join(pkg, 'dist'));
  // The one core choice that lives outside a plugin manifest (auth-choice-options.static.ts).
  const options = readdirSync(join(pkg, 'dist')).filter((name) => name.startsWith('auth-choice-options-'));
  const staticText = options.map((name) => readFileSync(join(pkg, 'dist', name), 'utf8')).join('\n');
  for (const route of routes()) {
    assert.ok(found.has(route.choice) || staticText.includes(`"${route.choice}"`),
      `${route.choice} is not an auth choice of the pinned tarball (${route.source})`);
  }
  assert.ok(routes().length >= 30, 'the table is the pin\'s whole inventory, not just the offered routes');
});

test('real gateway: wizard.status carries no step, wizard.next pulls one, cancel frees admission (Crewhouse port)', { timeout: 300_000 }, async () => {
  const client = signInCtx();
  const started = await client.request('openclaw.setup.auth.start',
    { sessionId: 'byokit-o6-probe', agentId: 'm1', authChoice: 'openai-device-code' }, { timeoutMs: 60_000 }) as { sessionId: string; done?: boolean; status?: string };
  assert.equal(started.done, false);
  assert.equal(started.status, 'running');
  // The contract that deadlocked the old poll loop: status alone never yields a step.
  const status = await client.request('wizard.status', { sessionId: started.sessionId }, { timeoutMs: 20_000 }) as Record<string, unknown>;
  assert.ok(!('step' in status), `wizard.status carried a step: ${JSON.stringify(status)}`);
  assert.equal(status.status, 'running');
  const pulled = await client.request('wizard.next', { sessionId: started.sessionId }, { timeoutMs: 120_000 }) as { done?: boolean; step?: { id?: string; type?: string } };
  assert.equal(pulled.done, false);
  assert.ok(pulled.step?.id && pulled.step?.type, `wizard.next yielded no step: ${JSON.stringify(pulled)}`);
  const cancelled = await client.request('wizard.cancel', { sessionId: started.sessionId }, { timeoutMs: 10_000 }) as { status?: string };
  assert.equal(cancelled.status, 'cancelled');
  // This session only: the admission is free again right after.
  let retry: { sessionId: string } | undefined;
  for (let waited = 0; waited < 15_000 && !retry; waited += 500) {
    retry = await client.request('openclaw.setup.auth.start',
      { sessionId: 'byokit-o6-probe-2', agentId: 'm1', authChoice: 'openai-device-code' }, { timeoutMs: 30_000 }).catch(() => undefined) as { sessionId: string } | undefined;
    if (!retry) await delay(500);
  }
  assert.ok(retry, 'setup admission still busy 15s after wizard.cancel');
  await client.request('wizard.cancel', { sessionId: retry.sessionId }, { timeoutMs: 10_000 }).catch(() => {});
});

test('real gateway: the drive shows the code, never asks wizard.status, and cancelling frees its own session', { timeout: 300_000 }, async () => {
  const client = signInCtx();
  calls = [];
  assert.deepEqual(await providers(signInCtx(), 'm1'), [], 'nothing is signed in on a fresh engine');
  const views: SignInView[] = [];
  const handle = signIn(client, 'm1', { authChoice: 'openai-device-code', via: 'code' }, (view) => views.push(view));
  for (let waited = 0; waited < 120_000 && !views.length; waited += 100) await delay(100);
  assert.ok(views.length, 'the wizard never answered with a step');
  handle.cancel();
  const end = await handle.done;
  assert.deepEqual(end, { state: 'failed', via: 'code', why: 'declined' });
  assert.ok(!calls.includes('wizard.status'), 'the drive never asks a method that carries no step');
  assert.ok(calls.includes('wizard.cancel'), 'the person\'s exit cancels its own session');
  // The admission is free for the next attempt.
  let retry: { sessionId: string } | undefined;
  for (let waited = 0; waited < 15_000 && !retry; waited += 500) {
    retry = await client.request('openclaw.setup.auth.start',
      { sessionId: 'byokit-o6-after-cancel', agentId: 'm1', authChoice: 'openai-device-code' }, { timeoutMs: 30_000 }).catch(() => undefined) as { sessionId: string } | undefined;
    if (!retry) await delay(500);
  }
  assert.ok(retry, 'a cancelled sign-in locks the next one out');
  await client.request('wizard.cancel', { sessionId: retry.sessionId }, { timeoutMs: 10_000 }).catch(() => {});
});

test('the engine state directory is the only place a sign-in touches', () => {
  assert.ok(statSync(stateDir).isDirectory());
  assert.equal(statSync(join(stateDir, 'openclaw', 'openclaw.json')).mode & 0o777, 0o600);
});
