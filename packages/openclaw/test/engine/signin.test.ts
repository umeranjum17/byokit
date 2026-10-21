// The pinned engine's own wizard, for real (5.7, O6): offered guided routes start, and the
// drive speaks the contract the gateway actually serves — steps only from wizard.next, one setup admission at a time.
import { test, before, after, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../../src/engine.ts';
import { OpenClawKit } from '../../src/kit.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { providers, signIn, type SignInCtx } from '../../src/signin.ts';
import { words } from '../../src/words.ts';
import { routes } from '../../src/routes.ts';
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
  assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, '2026.9.33', 'the pinned tarball is installed');
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
    // The gateway is spawned as [entry, 'gateway', ...]. Install-time node children (the lifecycle script) run before the
    // engine has a set, so the entry is matched by its path, not by doctorContext(), which throws until the set exists.
    if (file === process.execPath && Array.isArray(argv) && argv[0]?.endsWith(join('node_modules', 'openclaw', 'openclaw.mjs'))) {
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
    authConfig: () => '',
    restarted: async () => true,
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
    return await fn({ request, ensure: async (member: string) => ({ agentId: member }), callbackPort: 0, authConfig: () => '', restarted: async () => true }, request, state);
  } finally {
    await probeTransport?.stop().catch(() => {});
    await probe.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test('discovery matches the pinned gateway: every ready choice is set up, every no_upstream_flow choice is refused', { timeout: 900_000 }, async () => {
  const { choices } = pinnedChoices();
  // CLI routes are detected, not set up; a choice outside the tarball needs an external plugin.
  const table = routes().filter((route) => route.via !== 'cli' && choices.has(route.choice)
    && (route.readiness === 'ready' || route.readiness === 'no_upstream_flow'));
  assert.ok(['opencode-go', 'fal-api-key', 'openai'].every((choice) => table.some((route) => route.choice === choice)));
  const refused = /not available on this Gateway/i;
  await withGateway([...new Set(table.map((route) => route.plugin).filter((id): id is string => !!id))], async (_ctx, request) => {
    // One setup admission at a time; a cancelled session frees it shortly after (N5): retry busy, bounded.
    const said = (failure: unknown) => String(failure instanceof Error ? failure.message : failure);
    const busy = /already in progress|SETUP_ADMISSION_BUSY/i;
    const settled = async (probe: () => Promise<string>): Promise<string> => {
      let error = '';
      for (let tries = 0; tries < 50; tries++) {
        error = await probe().catch(said);
        if (!busy.test(error)) return error;
        await delay(200);
      }
      return assert.fail(`the setup admission never freed: ${error}`);
    };
    for (const route of table) {
      const sessionId = `byokit-discovery-${route.choice}`;
      // A key is refused before any request leaves; a stand-in key then fails its live test offline and writes
      // nothing. A login session opens either way; the gateway refuses the choice on the first pulled step.
      const error = await settled(async () => {
        if (route.keyEntry) {
          const result = await request('openclaw.setup.activate', { kind: 'api-key', agentId: 'm1', authChoice: route.choice,
            apiKey: 'byokit-probe-not-a-key' }, { timeoutMs: 120_000 }) as { ok?: boolean; error?: string };
          assert.ok(!result.ok, `${route.choice}: a stand-in key activated`);
          return String(result.error ?? '');
        }
        const started = await request('openclaw.setup.auth.start', { sessionId, agentId: 'm1', authChoice: route.choice },
          { timeoutMs: 60_000 }) as { error?: string };
        return String(started.error ?? '')
          || String((await request('wizard.next', { sessionId }, { timeoutMs: 120_000 }) as { error?: string }).error ?? '');
      });
      if (!route.keyEntry) await request('wizard.cancel', { sessionId }, { timeoutMs: 10_000 }).catch(() => {});
      if (route.readiness === 'ready') assert.doesNotMatch(error, refused, `${route.choice} is ready but the gateway refuses it: ${error}`);
      else assert.match(error, refused, `${route.choice} is no_upstream_flow but the gateway sets it up: ${error || 'no error'}`);
    }
  });
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

test('real gateway: a sign-in cancelled at 0 ms has freed the setup admission once it is done (N5)', { timeout: 300_000 }, async () => {
  await withGateway(['openai'], async (ctx, request) => {
    const handle = signIn(ctx, 'm1', { authChoice: 'openai-device-code', via: 'code' }, () => {});
    // Cancelled before the start has settled: the cancel waits for the session the engine registers as it settles.
    handle.cancel();
    assert.equal((await handle.done).why, 'declined');
    // No retry: the very next start is admitted.
    const retry = await request('openclaw.setup.auth.start',
      { sessionId: 'byokit-after-cancel-at-zero', agentId: 'm1', authChoice: 'openai-device-code' },
      { timeoutMs: 30_000 }) as { sessionId: string };
    await request('wizard.cancel', { sessionId: retry.sessionId }, { timeoutMs: 10_000 }).catch(() => {});
  });
});

test('real gateway: without a caller allowlist the drive shows the code, pulls steps only with wizard.next, and a cancelled sign-in admits the next one at once', { timeout: 300_000 }, async (t) => {
  calls = [];
  // Each session's start, cancel and settlement as the engine answered them, sessions numbered in order.
  const trace: string[] = [];
  const at: number[] = [];
  const sessions: string[] = [];
  const base = signInCtx();
  const client: SignInCtx = { ...base, request: async (method, params, options) => {
    const id = (params as { sessionId?: string } | undefined)?.sessionId;
    const note = (answer: string) => {
      if (!id || method === 'wizard.next') return;
      if (!sessions.includes(id)) sessions.push(id);
      trace.push(`${sessions.indexOf(id) + 1} ${method} ${answer}`);
      at.push(Date.now());
    };
    try {
      const answer = await base.request(method, params, options) as { status?: string } | undefined;
      note(String(answer?.status));
      return answer;
    } catch (error) { note(error instanceof Error ? error.message : String(error)); throw error; }
  } };
  assert.deepEqual(await providers(signInCtx(), 'm1'), [], 'nothing is signed in on a fresh engine');
  const signInThenCancel = async (ctx: SignInCtx) => {
    const views: SignInView[] = [];
    const handle = signIn(ctx, 'm1', { authChoice: 'openai-device-code', via: 'code' }, (view) => views.push(view));
    for (let waited = 0; waited < 120_000 && !views.length; waited += 100) await delay(100);
    assert.ok(views.some(view => view.state === 'waiting' && view.code?.startsWith('MOCK-')),
      `the drive displays the loopback fake code: ${JSON.stringify({ views, trace, requests: openai.state.requests.map(request => request.path) })}`);
    handle.cancel();
    assert.deepEqual(await handle.done, { state: 'failed', via: 'code', why: 'declined', error: words('signin.cancelled') });
  };
  await signInThenCancel(client);
  assert.ok(!calls.slice(0, calls.indexOf('wizard.cancel')).includes('wizard.status'), 'the drive pulls steps only with wizard.next');
  // Straight to the engine the moment done settles: the kit ensures a member once (members.ts).
  await signInThenCancel({ ...client, ensure: async (member) => ({ agentId: member }) });
  t.diagnostic(trace.map((line, index) => `+${at[index] - at[0]} ms ${line}`).join('\n'));
  assert.deepEqual(trace.map((line) => line.split(' ').slice(0, 2).join(' ')), ['1 openclaw.setup.auth.start', '1 wizard.cancel',
    '1 wizard.status', '2 openclaw.setup.auth.start', '2 wizard.cancel', '2 wizard.status'], 'each wizard.status answers before the next start');
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
  assert.deepEqual(await probeClaudeCliAuthStatus({ command, env }), { status: 'available' });
  assert.deepEqual(await probeClaudeCliAuthStatus({ command, env: { ...env, TEST_CLAUDE_LOGIN: 'no' } }), { status: 'missing' });
});

test('setup.detect rechecks a newly signed-in installed Claude and restarts the gateway itself', { timeout: 300_000 }, async () => {
  const dir = scratchDir('o6-claude-redetect'), home = join(dir, 'home'), bin = join(dir, 'bin');
  mkdirSync(home, { recursive: true }); mkdirSync(bin);
  const status = join(dir, 'claude-status'), calls = join(dir, 'claude-calls');
  writeFileSync(status, 'signed-out');
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), state = fs.readFileSync(${JSON.stringify(status)}, 'utf8');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }) + '\\n');
const a = process.argv.slice(2).join(' ');
if (a === 'auth status --json') console.log(JSON.stringify({ loggedIn: state === 'signed-in' }));
else if (a === 'auth status --text') { if (state === 'signed-in') console.log('Login method: Claude Max Account'); else process.exit(1); }
else if (process.argv[2] === '--version') console.log('2.1.0 (Claude Code)');
else process.exit(2);
`, { mode: 0o700 });
  const saved = Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']
    .map(name => [name, process.env[name]]));
  process.env.HOME = home;
  for (const name of Object.keys(saved).slice(1)) delete process.env[name];
  const stateDir = join(dir, 'state'), kit = new OpenClawKit({ stateDir, engineDir, enginePath: [bin], callbackPort: 0 });
  const detection = async () => await kit.call('openclaw.setup.detect', { agentId: 'm1' }, { timeoutMs: 30_000 }) as {
    candidates?: { kind?: string; credentials?: boolean }[];
  };
  try {
    await kit.start();
    const oldPid = Number(readFileSync(join(stateDir, 'openclaw', 'gateway.pid'), 'utf8'));
    const fallback = await detection();
    assert.ok(fallback.candidates?.some(row => row.kind === 'claude-cli' && row.credentials === false),
      `signed-out installed Claude remains a sign-in candidate: ${JSON.stringify(fallback.candidates)}`);
    // The gateway's own detection runs `auth status --text`; the kit's probe runs `--json`.
    const lastCliCall = () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(call => call.argv.join(' ') === 'auth status --text').at(-1);
    assert.equal(lastCliCall().CLAUDE_CONFIG_DIR, join(stateDir, 'openclaw', 'home', '.claude'),
      'initial gateway setup detection reads the fallback login');

    writeFileSync(status, 'signed-in');
    const signedIn = await detection();
    assert.ok(signedIn.candidates?.some(row => row.kind === 'claude-cli' && row.credentials === true),
      `the next setup.detect reports the installed login: ${JSON.stringify(signedIn.candidates)}`);
    assert.equal(kit.state.phase, 'ready');
    const newPid = Number(readFileSync(join(stateDir, 'openclaw', 'gateway.pid'), 'utf8'));
    assert.notEqual(newPid, oldPid, 'setup.detect caused the gateway restart without a kit/app restart');
    assert.equal(lastCliCall().HOME, home);
    assert.equal(lastCliCall().CLAUDE_CONFIG_DIR, undefined, 'restarted gateway setup detection reads the installed Claude login');
  } finally {
    await kit.stop();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  }
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
