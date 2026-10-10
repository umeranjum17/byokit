// The pinned engine's own wizard, for real (5.7, O6): choices match bundled or external pin metadata, and the
// drive speaks the contract the gateway actually serves — steps only from wizard.next, one setup admission at a time.
import { test, before, after, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../../src/engine.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { providers, signIn, type SignInCtx } from '../../src/signin.ts';
import { words } from '../../src/words.ts';
import { routes } from '../../src/routes.ts';
import pinSnapshot from '../fixtures/routes-pin.json' with { type: 'json' };
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';
import type { GatewayTransport, SignInView } from '../../src/types.ts';
import { mockOpenAI } from '../../../accounts/src/testing/index.ts';

const install = scratchDir('o6-engine-signin');
const engineDir = sharedEngineDir() ?? join(install, 'engine');
const stateDir = join(install, 'state');
// 5.6: offered routes must work without the app having to allow their provider plugins itself.
const engine = new Engine({ stateDir, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true,
  onState: () => {}, onExit: () => {} });
let transport: GatewayTransport;
let calls: string[] = [];
let openai: Awaited<ReturnType<typeof mockOpenAI>>;

/** The pin's own inventory: every bundled manifest's `providerAuthChoices`, and the manifest id that owns each. */
const pinnedChoices = (): { choices: Map<string, string>; guided: Set<string>; staticChoices: string } => {
  const pkg = dirname(engine.doctorContext().entry);
  assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, '2026.8.35', 'the pinned tarball is installed');
  const choices = new Map<string, string>();
  const guided = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (entry.name !== 'openclaw.plugin.json') continue;
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { id?: string; providerAuthChoices?: { choiceId?: string; appGuidedAuth?: string; assistantVisibility?: string }[] };
      for (const choice of manifest.providerAuthChoices ?? []) {
        if (!choice.choiceId) continue;
        choices.set(choice.choiceId, manifest.id ?? '');
        if (choice.appGuidedAuth && choice.assistantVisibility !== 'manual-only') guided.add(choice.choiceId);
      }
    }
  };
  walk(join(pkg, 'dist'));
  // The one core static choice lives outside every manifest (auth-choice-options.static.ts).
  const options = readdirSync(join(pkg, 'dist')).filter((name) => name.startsWith('auth-choice-options-'));
  return { choices, guided, staticChoices: options.map((name) => readFileSync(join(pkg, 'dist', name), 'utf8')).join('\n') };
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
    if (file === process.execPath && Array.isArray(argv) && argv.includes(engine.doctorContext().entry)) {
      return spawn(file, ['--import', pathToFileURL(preload).href, ...argv], options);
    }
    return spawn(...args);
  });
  syncBuiltinESMExports();
  const ctx = await engine.start();
  assert.ok(ctx);
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
async function withGateway<T>(plugins: string[], fn: (ctx: SignInCtx, request: GatewayTransport['request'], state: string) => Promise<T>, enginePath?: string[]): Promise<T> {
  const dir = scratchDir(`o6-gateway-${plugins.join('-') || 'none'}`);
  const state = join(dir, 'state');
  const probe = new Engine({ stateDir: state, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true, enginePath,
    config: { plugins: { allow: plugins } }, onState: () => {}, onExit: () => {} });
  let probeTransport: GatewayTransport | undefined;
  try {
    const seam = await probe.start();
    assert.ok(seam);
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

test('routes.json and bundled/external pin metadata agree in both directions (5.7, 5.12, B6)', { timeout: 120_000 }, () => {
  const { choices, staticChoices } = pinnedChoices();
  for (const route of routes()) {
    if (!route.choice) {
      assert.equal(route.readiness, 'no_upstream_flow', route.provider);
      continue;
    }
    if (route.needs?.plugin) {
      assert.ok(pinSnapshot.manifests.some(manifest => manifest.id === route.plugin
        && 'providerAuthChoices' in manifest && (manifest.providerAuthChoices ?? []).some(choice => choice.choiceId === route.choice)),
      `${route.choice} must exist in the external pin manifest snapshot`);
      assert.equal(route.needs.plugin, route.plugin);
      continue;
    }
    assert.ok(choices.has(route.choice) || staticChoices.includes(`"${route.choice}"`),
      `${route.choice} is not an auth choice of the pinned tarball (${route.source})`);
  }
  assert.equal(routes().length, 96, 'full discovery includes unavailable choices, not just bundled ones');
  const catalog = JSON.parse(readFileSync(join(dirname(engine.doctorContext().entry), 'scripts/lib/official-external-provider-catalog.json'), 'utf8')) as {
    entries: { openclaw: { plugin: { id: string }; providers: { authChoices?: { choiceId: string }[] }[] } }[];
  };
  for (const { openclaw } of catalog.entries) for (const provider of openclaw.providers) {
    for (const choice of provider.authChoices ?? []) {
      assert.equal(routes().find(route => route.choice === choice.choiceId)?.plugin, openclaw.plugin.id, choice.choiceId);
    }
  }
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

test('every offered app-guided route starts without a caller allowlist (5.7, B6)', { timeout: 900_000 }, async () => {
  const { guided } = pinnedChoices();
  assert.ok(guided.has('openai-device-code'), 'guided choices are read from the pinned inventory');
  for (const route of routes().filter((entry) => entry.offer && guided.has(entry.choice))) {
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
  assert.deepEqual(end, { state: 'failed', via: 'code', why: 'declined', error: words('signin.cancelled') });
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

test('the pinned wizard completes device approval after three minutes of fake time', async (t) => {
  // Exercise the real engine's WizardSession and prompter without a provider account or outbound fetch.
  const dist = join(dirname(engine.doctorContext().entry), 'dist');
  const file = readdirSync(dist).find((name) => name.startsWith('session-') && name.endsWith('.js')
    && readFileSync(join(dist, name), 'utf8').includes('WizardSession as t'));
  assert.ok(file, 'the pin must expose its wizard implementation');
  const { t: WizardSession } = await import(pathToFileURL(join(dist, file)).href);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new WizardSession(async (prompter: any) => {
    await prompter.deviceCode({ code: 'UMER-2026', expiresInMinutes: 15 });
    await new Promise((resolve) => setTimeout(resolve, 181_000));
  });
  const request: GatewayTransport['request'] = async (method, params: any, options) => {
    if (method === 'openclaw.setup.auth.start') return { done: false };
    if (method === 'wizard.cancel') { session.cancel(); return {}; }
    assert.equal(method, 'wizard.next');
    if (params.answer) await session.answer(params.answer.stepId, params.answer.value);
    // The actual client requires null to disable its default timeout on a long request.
    if (params.answer) assert.equal(options?.timeoutMs, null);
    return session.next();
  };
  const handle = signIn({ request, ensure: async () => ({ agentId: 'umer' }), callbackPort: 0 },
    'umer', { authChoice: 'openai-device-code', via: 'code' }, () => {});
  await turn();
  t.mock.timers.tick(181_000);
  assert.deepEqual(await handle.done, { state: 'done', via: 'code' });
});

test('the engine state directory is the only place a sign-in touches', () => {
  assert.ok(statSync(stateDir).isDirectory());
  assert.equal(statSync(join(stateDir, 'openclaw', 'openclaw.json')).mode & 0o777, 0o600);
});


test('native Claude auth seam asks a task-owned CLI, clears overrides, and returns no credentials', async () => {
  const { probeClaudeCliAuthStatus } = await import(pathToFileURL(join(dirname(engine.doctorContext().entry),
    'dist', 'extensions', 'anthropic', 'cli-auth-seam.js')).href);
  const command = join(install, 'fake-claude');
  writeFileSync(command, `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'auth status --json') process.exit(2);
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN) process.exit(3);
console.log(JSON.stringify({ loggedIn: process.env.TEST_CLAUDE_LOGIN === 'yes', accessToken: 'fake-token-must-not-escape' }));
`, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: install, CLAUDE_CONFIG_DIR: join(install, '.claude'),
    ANTHROPIC_API_KEY: 'fake-key', ANTHROPIC_OAUTH_TOKEN: 'fake-token', TEST_CLAUDE_LOGIN: 'yes' };
  assert.deepEqual(probeClaudeCliAuthStatus({ command, env }), { status: 'available' });
  assert.deepEqual(probeClaudeCliAuthStatus({ command, env: { ...env, TEST_CLAUDE_LOGIN: 'no' } }), { status: 'missing' });
});

test('real gateway: a Claude Code login the engine detects is a signed-in claude-cli', { timeout: 300_000 }, async () => {
  // A task-owned `claude` on the engine's PATH, logged in on a plan; it prints no credential.
  const bin = scratchDir('o6-claude-bin');
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('2.1.0 (Claude Code)');
else if (a === 'auth status --text') console.log('Login method: Claude Max Account');
else if (a === 'auth status --json') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
else process.exit(2);
`, { mode: 0o700 });
  try {
    await withGateway(['anthropic'], async (ctx, request) => {
      const detected = await request('openclaw.setup.detect', { agentId: 'm1' }, { timeoutMs: 20_000 }) as { candidates?: { kind?: string; credentials?: boolean }[] };
      assert.ok(detected.candidates?.some((c) => c.kind === 'claude-cli' && c.credentials === true),
        `the engine detects the login: ${JSON.stringify(detected.candidates?.map((c) => [c.kind, c.credentials]))}`);
      const status = await request('models.authStatus', { agentId: 'm1', refresh: true }, { timeoutMs: 20_000 });
      // Exactly claude-cli: a Claude Code login is plan-billed and never reads as 'anthropic', the API-billed provider.
      assert.deepEqual(await providers(ctx, 'm1'), ['claude-cli'], `engine status: ${JSON.stringify(status)}`);
    }, [bin]);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
