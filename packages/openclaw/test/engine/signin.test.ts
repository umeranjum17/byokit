// The pinned engine's own wizard, for real (5.7, O6): every choice id in routes.json exists in the tarball, and the
// drive speaks the contract the gateway actually serves — steps only from wizard.next, one setup admission at a time.
import { test, before, after, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../../src/engine.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { providers, signIn, type SignInCtx } from '../../src/signin.ts';
import { routes } from '../../src/routes.ts';
import { scratchDir } from '../../../test-support.ts';
import type { GatewayTransport, SignInView } from '../../src/types.ts';
import { mockOpenAI } from '../../../accounts/src/testing/index.ts';

const install = scratchDir('o6-engine-signin');
const engineDir = join(install, 'engine');
const stateDir = join(install, 'state');
// 5.6: offered routes must work without the app having to allow their provider plugins itself.
const engine = new Engine({ stateDir, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true,
  onState: () => {}, onExit: () => {} });
let transport: GatewayTransport;
let calls: string[] = [];
let openai: Awaited<ReturnType<typeof mockOpenAI>>;

/** The pin's own inventory: every bundled manifest's `providerAuthChoices`, and the manifest id that owns each. */
const pinnedChoices = (): { choices: Map<string, string>; staticChoices: string } => {
  const pkg = join(engineDir, 'node_modules', 'openclaw');
  assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, '2026.8.1', 'the pinned tarball is installed');
  const choices = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (entry.name !== 'openclaw.plugin.json') continue;
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { id?: string; providerAuthChoices?: { choiceId?: string }[] };
      for (const choice of manifest.providerAuthChoices ?? []) if (choice.choiceId) choices.set(choice.choiceId, manifest.id ?? '');
    }
  };
  walk(join(pkg, 'dist'));
  // The one core static choice lives outside every manifest (auth-choice-options.static.ts).
  const options = readdirSync(join(pkg, 'dist')).filter((name) => name.startsWith('auth-choice-options-'));
  return { choices, staticChoices: options.map((name) => readFileSync(join(pkg, 'dist', name), 'utf8')).join('\n') };
};

/** The gateway needs a moment to bind after spawn: connect only once the port answers. */
export const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

before(async () => {
  openai = await mockOpenAI({ email: 'umer@example.com' });
  // Only this file's task-owned gateway receives the auth fake. The tarball,
  // production spawn policy and offline egress guard remain intact.
  const preload = join(install, 'auth-fake.mjs');
  writeFileSync(preload, `
import { mock } from 'node:test';
const fetch = globalThis.fetch;
// The pinned engine recognizes mock.method's mock metadata as its fetch injection seam.
mock.method(globalThis, 'fetch', (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://auth.openai.com') {
    const base = new URL(${JSON.stringify(openai.base)});
    url.protocol = base.protocol; url.host = base.host;
    input = input instanceof Request ? new Request(url, input) : url;
  }
  return fetch(input, options);
});
`, { mode: 0o600 });
  const spawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const [file, argv, options] = args;
    if (file === process.execPath && Array.isArray(argv) && argv.includes(join(engineDir, 'node_modules', 'openclaw', 'openclaw.mjs'))) {
      return spawn(file, ['--import', pathToFileURL(preload).href, ...argv], options);
    }
    return spawn(...args);
  });
  syncBuiltinESMExports();
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

after(async () => {
  try { await transport?.stop(); await engine.stop(); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); await openai?.close(); }
});

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

/** The kit's own ctx over a fresh task-owned gateway: one setup admission each, caller plugins merged (5.6). */
async function withGateway<T>(plugins: string[], fn: (ctx: SignInCtx, request: GatewayTransport['request'], state: string) => Promise<T>): Promise<T> {
  const dir = scratchDir(`o6-gateway-${plugins.join('-') || 'none'}`);
  const state = join(dir, 'state');
  const probe = new Engine({ stateDir: state, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true,
    config: { plugins: { allow: plugins } }, onState: () => {}, onExit: () => {} });
  let probeTransport: GatewayTransport | undefined;
  try {
    const seam = await probe.start();
    for (let waited = 0; waited < 120_000; waited += 200) {
      if (await listening(seam.port)) break;
      await delay(200);
      if (waited >= 119_800) throw new Error('the gateway never listened');
    }
    probeTransport = gatewayTransport({ ...seam, bridgeSock: probe.bridgeSock });
    await probeTransport.start();
    const transport = probeTransport;
    const request: GatewayTransport['request'] = (method, params, options) => transport.request(method, params, options);
    const list = await request('agents.list') as { agents: { id: string }[] };
    if (!list.agents.some((agent) => agent.id === 'm1'))
      await request('agents.create', { name: 'm1', workspace: join(state, 'openclaw', 'workspaces', 'm1') });
    return await fn({ request, ensure: async (member: string) => ({ agentId: member }), callbackPort: 0 }, request, state);
  } finally {
    await probeTransport?.stop().catch(() => {});
    await probe.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

test('routes.json and the pinned tarball agree in both directions, plugins included (5.7, 5.12)', { timeout: 120_000 }, () => {
  const { choices, staticChoices } = pinnedChoices();
  for (const route of routes()) {
    assert.ok(choices.has(route.choice) || staticChoices.includes(`"${route.choice}"`),
      `${route.choice} is not an auth choice of the pinned tarball (${route.source})`);
  }
  assert.ok(routes().length >= 30, 'the table is the pin\'s whole inventory, not just the offered routes');
  // The other direction, and the owning plugin of every choice: nothing pinned is unrouted, and no route names the
  // wrong plugin (the allowlist needs the owning id, 5.6).
  for (const [choice, plugin] of choices) {
    const route = routes().find((entry) => entry.choice === choice);
    assert.ok(route, `${choice} is a pinned auth choice with no route`);
    assert.equal(route.plugin, plugin, `${choice} names the wrong owning plugin`);
  }
  assert.ok(staticChoices.includes('"custom-api-key"'), 'the pin carries the core static choice');
  assert.equal(routes().find((entry) => entry.choice === 'custom-api-key')?.plugin, '', 'a core choice has no plugin');
});

test('every offered route starts on the real engine without a caller allowlist (5.7, B6)', { timeout: 900_000 }, async () => {
  for (const route of routes().filter((entry) => entry.offer)) {
    await withGateway([], async (_ctx, request) => {
      const sessionId = `byokit-probe-${route.choice}`;
      const started = await request('openclaw.setup.auth.start',
        { sessionId, agentId: 'm1', authChoice: route.choice }, { timeoutMs: 60_000 }) as { done?: boolean; error?: string };
      assert.ok(!started.error, `${route.choice}: ${started.error}`);
      const pulled = await request('wizard.next', { sessionId }, { timeoutMs: 120_000 }) as { done?: boolean; error?: string; step?: { id?: string } };
      assert.ok(!pulled.error, `${route.choice}: ${pulled.error}`);
      assert.doesNotMatch(String(pulled.error ?? ''), /not available|blocked by allowlist/i, route.choice);
      assert.ok(pulled.step?.id, `${route.choice}: no step arrived (${JSON.stringify(pulled)})`);
      await request('wizard.cancel', { sessionId }, { timeoutMs: 10_000 }).catch(() => {});
    });
  }
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

test('real gateway: a sign-in cancelled at 0 ms frees the setup admission within 5 s (N5)', { timeout: 300_000 }, async () => {
  await withGateway(['openai'], async (ctx, request) => {
    const handle = signIn(ctx, 'm1', { authChoice: 'openai-device-code', via: 'code' }, () => {});
    // Cancelled before the start has settled: the cancel waits for the session the engine registers as it settles.
    handle.cancel();
    assert.equal((await handle.done).why, 'declined');
    const startedAt = Date.now();
    let retry: { sessionId: string } | undefined;
    while (!retry && Date.now() - startedAt < 5_000) {
      retry = await request('openclaw.setup.auth.start',
        { sessionId: 'byokit-after-cancel-at-zero', agentId: 'm1', authChoice: 'openai-device-code' },
        { timeoutMs: 30_000 }).catch(() => undefined) as { sessionId: string } | undefined;
      if (!retry) await delay(100);
    }
    assert.ok(retry, `setup admission still busy ${Date.now() - startedAt} ms after a cancel at 0`);
    await request('wizard.cancel', { sessionId: retry.sessionId }, { timeoutMs: 10_000 }).catch(() => {});
  });
});

test('real gateway: without a caller allowlist the drive shows the code, never asks wizard.status, and cancelling frees its own session', { timeout: 300_000 }, async () => {
  const client = signInCtx();
  calls = [];
  assert.deepEqual(await providers(signInCtx(), 'm1'), [], 'nothing is signed in on a fresh engine');
  const views: SignInView[] = [];
  const handle = signIn(client, 'm1', { authChoice: 'openai-device-code', via: 'code' }, (view) => views.push(view));
  for (let waited = 0; waited < 120_000 && !views.length; waited += 100) await delay(100);
  assert.ok(views.length, 'the wizard never answered with a step');
  assert.ok(views.some(view => view.state === 'waiting' && view.code?.startsWith('MOCK-')),
    `the drive displays the loopback fake code: ${JSON.stringify({ views, requests: openai.state.requests.map(request => request.path) })}`);
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
