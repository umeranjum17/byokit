// The sign-in wizard drive against the contract the pinned gateway speaks (5.7): steps come only from wizard.next,
// every exit short of done cancels this task's own session, and the browser route holds the callback port itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { providers, signIn, type SignInCtx } from '../src/signin.ts';
import { OpenClawKit } from '../src/kit.ts';
import { Engine } from '../src/engine.ts';
import { openclawLink } from '../src/link.ts';
import { scratchDir } from '../../test-support.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { hostKeySeal } from '../../secrets/src/index.ts';
import { words } from '../src/words.ts';
import type { GatewayTransport, SignInView } from '../src/types.ts';

/** A transport stand-in that speaks the wizard contract from a script and records every method. */
function scripted(handlers: Record<string, (params: any, options?: any) => unknown>) {
  const calls: { method: string; params?: any }[] = [];
  const request: GatewayTransport['request'] = async (method, params, options) => {
    calls.push({ method, params: params as any });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected method ${method}`);
    return await handler(params, options);
  };
  return { calls, request, methods: () => calls.map((call) => call.method) };
}

const ctx = (fake: ReturnType<typeof scripted>, over: Partial<SignInCtx> = {}): SignInCtx => ({
  request: fake.request,
  ensure: async (member) => ({ agentId: member }),
  callbackPort: 0,
  authConfig: () => '',
  restarted: async () => true,
  ...over,
});

// The device-code script from Crewhouse's openclaw-wizard.test.ts, ported: the step, then progress, then done.
const DEVICE_STEP = {
  id: 'step-device', type: 'note', executor: 'client',
  deviceCode: { code: 'CREW-2026', expiresInMinutes: 15 }, externalUrl: 'https://auth.openai.com/codex/device',
};

const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((open) => probe.listen(0, '127.0.0.1', open));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((closed) => probe.close(() => closed()));
  return port;
};

const heldPort = async (): Promise<{ port: number; close(): Promise<void> }> => {
  const server = createServer(() => {});
  await new Promise<void>((open) => server.listen(0, '127.0.0.1', open));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((closed) => server.close(() => closed())) };
};

const bytes = (path: string) => readFileSync(path, 'utf8');

const get = (port: number, path: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.once('error', reject);
  req.end();
});

test('auth reload: the kit facade reconfirms through the replacement transport, never the dead socket', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let stored = false;
  const gateway = fakeGateway({
    'openclaw.setup.auth.start': () => ({ done: false }),
    'wizard.next': () => ({ step: { id: 'manual', type: 'text' } }),
    'models.authStatus': (params) => {
      assert.equal(params.agentId, 'selected');
      return { providers: stored ? [{ provider: 'openai', profiles: [
        { profileId: 'openai:selected', type: 'oauth', status: 'ok', expiry: { at: Date.now() + 999_999 } },
      ] }] : [] };
    },
  });
  const stateDir = scratchDir('signin-reconnect');
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: gateway.factory, callbackPort: 0 });
  try {
    await kit.start();
    const handle = kit.signIn('selected', { authChoice: 'openai' }, () => {});
    await turn();
    stored = true;
    gateway.drop('service restart');
    await turn();
    // With no child in this fixture the host reconnects; production's existing closed() supervision owns it.
    await kit.start();
    t.mock.timers.tick(1_000);
    await turn();
    assert.deepEqual(await handle.done, { state: 'done', via: 'browser' });
    assert.equal(kit.state.phase, 'ready');
    assert.equal(gateway.calls.filter((c) => c.method === 'openclaw.setup.auth.start').length, 1);
    assert.equal(gateway.calls.filter((c) => c.method === 'models.authStatus').length, 2);
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

// Model the real transport's timeout and signal while the engine holds wizard.next for approval.
function approvalGateway(afterMs: number, deviceCode: Record<string, unknown> = { code: 'UMER-2026', expiresInMinutes: 15 }, progress = false,
  step: Record<string, unknown> = { ...DEVICE_STEP, deviceCode }) {
  let shown = false;
  return scripted({
    'openclaw.setup.auth.start': () => ({ done: false }),
    'wizard.cancel': () => ({ status: 'cancelled' }),
    'wizard.next': (params: any, options?: any) => {
      if (!shown) { shown = true; return { step }; }
      if (params.answer && progress) { progress = false; return { step: { id: 'waiting', type: 'progress' } }; }
      return new Promise((resolve, reject) => {
        const timers: NodeJS.Timeout[] = [];
        const stop = (error?: Error) => {
          timers.forEach(clearTimeout);
          options.signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve({ done: true, status: 'done' });
        };
        const abort = () => stop(new Error('aborted'));
        options.signal.addEventListener('abort', abort, { once: true });
        timers.push(setTimeout(() => stop(), afterMs));
        if (options.timeoutMs != null) timers.push(setTimeout(() => stop(new Error('gateway request timeout for wizard.next')), options.timeoutMs));
      });
    },
  });
}

test('device approval after more than three minutes succeeds, including a progress pull', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = approvalGateway(181_000, undefined, true);
  const handle = signIn(ctx(fake), 'umer', { authChoice: 'openai-device-code', via: 'code' }, () => {});
  await turn();
  t.mock.timers.tick(181_000);
  assert.deepEqual(await handle.done, { state: 'done', via: 'code' });
});

test('a code printed only into a note reaches the caller with its link and expiry, and waits out approval', async (t) => {
  // The pinned engine's two text-only code notes, verbatim apart from the values.
  const at = Date.UTC(2026, 9, 5, 12, 0, 0);
  const notes = {
    minutes: ['Open this URL in your browser and enter the code below.', 'URL: https://example.test/login/device',
      'Code: UMER-2026', 'Code expires in 15 minutes. Never share it.'],
    clock: ['Open https://example.test/oauth to approve access.', 'If prompted, enter the code UMER-2026.',
      `Interval: 2000, Expires at: ${new Date(at + 600_000).toISOString()}`],
  };
  for (const [shape, lines] of Object.entries(notes)) await t.test(shape, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
    const message = lines.join('\n');
    const fake = approvalGateway(181_000, undefined, true,
      { id: 'step-note-code', type: 'note', title: 'Sign in', message, externalUrl: 'https://example.test/device' });
    const views: SignInView[] = [];
    const handle = signIn(ctx(fake), 'umer', { authChoice: 'github-copilot', via: 'code' }, (view) => views.push(view));
    await turn();
    t.mock.timers.tick(181_000);
    assert.deepEqual(await handle.done, { state: 'done', via: 'code' });
    assert.deepEqual(views[0], { state: 'waiting', via: 'code', code: 'UMER-2026', url: 'https://example.test/device',
      expiresAt: at + (shape === 'minutes' ? 900_000 : 600_000), message });
  });
});

test('device code expiry returns typed expired and cancels only its own session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = approvalGateway(900_000, { code: 'UMER-2026', expires_in: 240 });
  const handle = signIn(ctx(fake), 'umer', { authChoice: 'openai-device-code', via: 'code' }, () => {});
  await turn();
  t.mock.timers.tick(240_000);
  assert.deepEqual(await handle.done, { state: 'failed', via: 'code', why: 'expired', error: words('signin.expired') });
  assert.equal(fake.calls.filter((c) => c.method === 'wizard.cancel').length, 1);
  assert.equal(fake.calls.at(-1)?.params.sessionId, fake.calls[0]?.params.sessionId);
});

test('a caller signal cancels device approval through the kit facade', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = approvalGateway(900_000);
  const stateDir = scratchDir('o6-device-cancel');
  const gateway = fakeGateway();
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: (seam) => {
    const transport = gateway.factory(seam);
    return { ...transport, request: (method, params, options) => method.startsWith('wizard.') || method === 'openclaw.setup.auth.start'
      ? fake.request(method, params, options) : transport.request(method, params, options) };
  } });
  try {
    await kit.start();
    const controller = new AbortController();
    const views: SignInView[] = [];
    const handle = kit.signIn('umer', { authChoice: 'openai-device-code', via: 'code', signal: controller.signal }, (view) => views.push(view));
    await turn();
    t.mock.timers.tick(181_000);
    controller.abort();
    const end = await handle.done;
    assert.deepEqual(end, { state: 'failed', via: 'code', why: 'declined', error: words('signin.cancelled') });
    assert.deepEqual(views.at(-1), end);
    assert.equal(fake.calls.filter((c) => c.method === 'wizard.cancel').length, 1);
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('sign-in: a step that asks for a note is acknowledged and its address is surfaced', async () => {
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ sessionId: 'byokit-fake-note', done: false }),
    'wizard.next': (params: any) => params.answer
      ? { done: true, status: 'done' }
      : { done: false, step: { id: 'step-note', type: 'confirm', externalUrl: 'https://example.test/please' } },
  });
  const views: SignInView[] = [];
  const end = await signIn(ctx(fake), 'm1', { authChoice: 'xai-oauth' }, (view) => views.push(view)).done;
  assert.equal(end.state, 'done');
  assert.ok(views.some((view) => view.url === 'https://example.test/please'), JSON.stringify(views));
  assert.equal(fake.calls.find((call) => call.params?.answer)?.params.answer.stepId, 'step-note');
});

test('sign-in: a start the gateway refuses because another setup is running is why: busy', async () => {
  const fake = scripted({
    'openclaw.setup.auth.start': () => { throw new Error('OpenClaw setup is already in progress; try again when it finishes.'); },
  });
  const end = await signIn(ctx(fake), 'm1', { authChoice: 'openai-device-code', via: 'code' }, () => {}).done;
  assert.deepEqual(end, { state: 'failed', via: 'code', why: 'busy' });
  // A start the gateway refused may still have created its session (the id is ours to choose), so the drive cancels
  // exactly that id — never another session's.
  assert.deepEqual(fake.calls.filter((call) => call.method === 'wizard.cancel').map((call) => call.params?.sessionId),
    [fake.calls[0]!.params.sessionId]);
});

test('browser sign-in: the callback port is held, the redirect is pasted, and the page is in plain words', async () => {
  const port = await freePort();
  const answered: string[] = [];
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ sessionId: 'byokit-fake-4', done: false }),
    'wizard.next': (params: any) => {
      if (params.answer) { answered.push(params.answer.value); return { done: true, status: 'done' }; }
      return { done: false, step: { id: 'step-paste', type: 'text', sensitive: false } };
    },
  });
  const views: SignInView[] = [];
  const handle = signIn(ctx(fake, { callbackPort: port }), 'm1', { authChoice: 'openai', via: 'browser' }, (view) => views.push(view));
  let answeredPage: { status: number; body: string } | undefined;
  for (let waited = 0; waited < 5_000 && !answeredPage; waited += 25) {
    answeredPage = await get(port, '/auth/callback?code=one-time-code').catch(() => undefined);
    if (!answeredPage) await delay(25);
  }
  assert.ok(answeredPage, 'the callback listener never accepted the redirect');
  assert.equal(answeredPage.status, 200);
  assert.match(answeredPage.body, new RegExp(words('signin.returned').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const end = await handle.done;
  assert.equal(end.state, 'done');
  assert.deepEqual(answered, [`http://127.0.0.1:${port}/auth/callback?code=one-time-code`], 'the address is what the wizard gets');
  assert.ok(!fake.methods().includes('wizard.status'));
  // The listener dies with the sign-in: the port is free again.
  const reclaimed = createServer();
  await new Promise<void>((open, refuse) => {
    reclaimed.once('error', refuse);
    reclaimed.listen(port, '127.0.0.1', () => { reclaimed.close(() => open()); });
  });
});

test('browser sign-in: a taken callback port fails with why: busy before any session starts', async () => {
  const held = await heldPort();
  try {
    const fake = scripted({});
    const end = await signIn(ctx(fake, { callbackPort: held.port }), 'm1', { authChoice: 'openai', via: 'browser' }, () => {}).done;
    assert.deepEqual(end, { state: 'failed', via: 'browser', why: 'busy' });
    assert.deepEqual(fake.calls, [], 'a sign-in that cannot be answered never reaches the gateway');
  } finally { await held.close(); }
});

test('browser sign-in: cancelling while the wizard waits releases the port', async () => {
  const port = await freePort();
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ sessionId: 'byokit-fake-5', done: false }),
    'wizard.next': (params: any, options?: any) => new Promise((resolve, reject) => {
      if (params.answer) return resolve({ done: false, step: { id: 'step-wait', type: 'progress' } });
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      // never resolves: the drive is waiting for the person, exactly like a browser sign-in
    }),
    'wizard.cancel': () => ({ status: 'cancelled' }),
  });
  const handle = signIn(ctx(fake, { callbackPort: port }), 'm1', { authChoice: 'openai', via: 'browser' }, () => {});
  for (let waited = 0; waited < 2_000; waited += 25) {
    if ((await get(port, '/nothing').catch(() => undefined)) !== undefined) break;
    await delay(25);
  }
  handle.cancel();
  assert.equal((await handle.done).why, 'declined');
  const reclaimed = createServer();
  await new Promise<void>((open, refuse) => {
    reclaimed.once('error', refuse);
    reclaimed.listen(port, '127.0.0.1', () => { reclaimed.close(() => open()); });
  });
});

test('browser sign-in: only the provider callback is pasted, everything else is 404 (N6)', async () => {
  const port = await freePort();
  const answered: string[] = [];
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ done: false }),
    'wizard.next': (params: any) => {
      if (params.answer) { answered.push(params.answer.value); return { done: true, status: 'done' }; }
      return { done: false, step: { id: 'step-paste', type: 'text', sensitive: false } };
    },
  });
  const handle = signIn(ctx(fake, { callbackPort: port }), 'm1', { authChoice: 'openai', via: 'browser' }, () => {});
  let up = false;
  for (let waited = 0; waited < 5_000 && !up; waited += 25) {
    up = (await get(port, '/favicon.ico').catch(() => undefined)) !== undefined;
    if (!up) await delay(25);
  }
  assert.ok(up, 'the callback listener never came up');
  // A browser asks for plenty of things that are not the provider's redirect back.
  assert.equal((await get(port, '/favicon.ico')).status, 404);
  assert.equal((await get(port, '/auth/callback')).status, 404, 'no code in the query');
  assert.equal((await get(port, '/auth/callback?state=s')).status, 404, 'no code in the query');
  assert.equal((await get(port, '/auth/somewhere?code=one')).status, 404, 'not the callback path');
  assert.deepEqual(answered, [], 'none of those are a paste');
  const callback = await get(port, '/auth/callback?code=one-time-code&state=s');
  assert.equal(callback.status, 200);
  assert.match(callback.body, new RegExp(words('signin.returned').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((await handle.done).state, 'done');
  assert.deepEqual(answered, [`http://127.0.0.1:${port}/auth/callback?code=one-time-code&state=s`]);
});

test('sign-in: a failure is said in at most 200 characters', async () => {
  const fake = scripted({ 'openclaw.setup.auth.start': () => { throw new Error('x'.repeat(500)); } });
  const end = await signIn(ctx(fake), 'm1', { authChoice: 'openai-device-code', via: 'code' }, () => {}).done;
  assert.equal(end.why, 'failed');
  assert.equal(end.error?.length, 200);
});

test('providers does not invent a sign-in when the engine refuses to answer', async () => {
  const fake = scripted({ 'models.authStatus': () => { throw new Error('gateway is busy'); } });
  await assert.rejects(providers(ctx(fake), 'm1'), /gateway is busy/);
});

test('the kit drives the same flow through its own transport and members (5.3)', async () => {
  const stateDir = scratchDir('o6-facade');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
  try {
    await kit.start();
    assert.equal(await kit.signedIn('m1', 'openai'), false);
    assert.deepEqual(await kit.providers('m1'), []);
    assert.ok(kit.routes().some((route) => route.offer && route.provider === 'openai'));
    const views: SignInView[] = [];
    const done = await kit.signIn('m1', { authChoice: 'openai-device-code', via: 'code' }, (view) => views.push(view)).done;
    assert.equal(done.state, 'done');
    assert.ok(views.some((view) => view.state === 'waiting' && view.code), 'no device code was shown');
    assert.equal(await kit.signedIn('m1', 'openai'), true);
    await kit.signOut('m1', 'openai');
    assert.equal(await kit.signedIn('m1', 'openai'), false);
    assert.equal(fake.calls.filter((call) => call.method === 'agents.create').length, 1, 'the member is created once');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the kit never imports without an engine: a doctor run that cannot happen stages nothing and keeps the source (D15)', async () => {
  const stateDir = scratchDir('o6-kit-facade');
  const dir = scratchDir('o6-facade-migrate');
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a-preserved' } }));
  const kit = new OpenClawKit({ stateDir, spawnEngine: false });
  try {
    assert.equal(await kit.migrateRetainedLogin('m1', { path }), 'failed');
    assert.equal(bytes(path), JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a-preserved' } }));
    assert.equal(existsSync(join(stateDir, 'openclaw', 'state', 'agents', 'm1', 'agent', 'auth-profiles.json')), false);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sensitive setup-token wizard consumes an early or waiting paste once, without visible echoes', async (t) => {
  for (const early of [true, false]) await t.test(early ? 'early paste' : 'waiting paste', async () => {
    const token = 'synthetic-sensitive-canary';
    let pulls = 0;
    const fake = scripted({
      'openclaw.setup.auth.start': (params) => {
        assert.equal(params.agentId, 'selected');
        assert.equal(params.authChoice, 'setup-token');
        return { done: false };
      },
      'wizard.next': (params) => {
        if (params.answer) {
          assert.deepEqual(params.answer, { stepId: 'secret', value: token });
          return { step: { id: 'notice', type: 'note', externalUrl: `https://example.test/${token}` }, error: token };
        }
        if (++pulls === 1) return { step: { id: 'secret', type: 'text', sensitive: true,
          externalUrl: `https://example.test/${token}`, deviceCode: { code: token } } };
        return { done: true };
      },
      'wizard.cancel': () => ({}),
    });
    // The help note is acknowledged separately, never with a retained token.
    const request: GatewayTransport['request'] = (method, params: any, options) => {
      if (method === 'wizard.next' && params.answer?.stepId === 'notice') {
        assert.deepEqual(params.answer, { stepId: 'notice' });
        return Promise.resolve({ done: true });
      }
      return fake.request(method, params, options);
    };
    const views: SignInView[] = [];
    const handle = signIn(ctx(fake, { request }), 'selected', { authChoice: 'setup-token' }, (v) => views.push(v));
    if (!early) await turn();
    handle.paste(token);
    assert.deepEqual(await handle.done, { state: 'done', via: 'browser' });
    assert.equal(fake.calls.filter((c) => c.params?.answer?.value === token).length, 1);
    assert.ok(views.some((v) => v.prompt === 'Sign-in token'));
    assert.ok(!JSON.stringify(views).includes(token));
  });
});

test('sensitive wizard failures never echo secrets from returned or thrown errors', async (t) => {
  for (const scenario of ['terminal', 'throw', 'later-throw', 'start-throw'] as const) await t.test(scenario, async () => {
    const token = 'synthetic-error-canary';
    const fake = scripted({
      'openclaw.setup.auth.start': () => {
        if (scenario === 'start-throw') throw new Error(token);
        return { done: false };
      },
      'wizard.next': (params) => {
        if (!params.answer) return { step: { id: 'secret', type: 'text', sensitive: true } };
        if (scenario === 'throw' || params.answer.stepId === 'notice') throw new Error(token);
        if (scenario === 'later-throw') return { step: { id: 'notice', type: 'action', externalUrl: token }, error: token };
        return { done: true, status: 'error', error: token };
      },
      'wizard.cancel': () => { throw new Error(token); },
    });
    const views: SignInView[] = [];
    const handle = signIn(ctx(fake), 'selected', { authChoice: 'setup-token' }, (v) => views.push(v));
    handle.paste(token);
    const end = await handle.done;
    assert.equal(end.why, 'failed');
    assert.equal(end.error, 'Sign-in failed. Try again.');
    assert.ok(!JSON.stringify({ views, end }).includes(token));
    assert.equal(fake.calls.filter((c) => c.method === 'wizard.cancel').length, 1);
  });
});

test('sensitive text on any typed auth choice preserves cancellation, timeout and one-use ordering', async (t) => {
  for (const scenario of ['cancel', 'abort', 'timeout', 'second-text'] as const) await t.test(scenario, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const token = 'synthetic-order-canary';
    const controller = new AbortController();
    const fake = scripted({
      'openclaw.setup.auth.start': () => ({ done: false }),
      'wizard.next': (params) => params.answer
        ? { step: { id: 'second', type: 'text', sensitive: true } }
        : { step: { id: 'first', type: 'text', sensitive: true } },
      'wizard.cancel': () => ({}),
    });
    const views: SignInView[] = [];
    const handle = signIn(ctx(fake), 'selected', { authChoice: 'custom-provider-choice', signal: controller.signal }, (v) => views.push(v));
    await turn();
    if (scenario === 'second-text') { handle.paste(token); await turn(); }
    if (scenario === 'cancel' || scenario === 'second-text') handle.cancel();
    else if (scenario === 'abort') controller.abort();
    else t.mock.timers.tick(15 * 60_000);
    const end = await handle.done;
    assert.equal(end.why, scenario === 'timeout' ? 'expired' : 'declined');
    assert.equal(fake.calls.filter((c) => c.params?.answer).length, scenario === 'second-text' ? 1 : 0);
    assert.equal(fake.calls.filter((c) => c.method === 'wizard.cancel').length, 1);
    assert.equal(fake.calls.at(-1)?.params.sessionId, fake.calls[0]?.params.sessionId);
    assert.ok(!JSON.stringify({ views, end }).includes(token));
  });
});

test('sensitive sign-in through the kit and link isolates members and keeps results, notices and logs clean', async () => {
  const stateDir = scratchDir('sensitive-signin');
  const tokens = { ana: 'synthetic-ana-canary', bea: 'synthetic-bea-canary' };
  const sessions = new Map<string, string>();
  const received: { member: string; value: string }[] = [];
  const gateway = fakeGateway({
    'models.authStatus': (params) => ({ providers: received.some((r) => r.member === params.agentId && r.member === 'ana') ? ['github-copilot'] : [] }),
    'openclaw.setup.auth.start': (params) => {
      sessions.set(String(params.sessionId), String(params.agentId));
      return { done: false };
    },
    'wizard.next': (params: any) => {
      const member = sessions.get(params.sessionId)!;
      if (!params.answer) return { step: { id: 'token', type: 'text', sensitive: true } };
      received.push({ member, value: params.answer.value });
      return member === 'ana' ? { done: true } : { done: true, status: 'error', error: params.answer.value };
    },
    'wizard.cancel': () => ({}),
  });
  const logs: string[] = [];
  const notices: unknown[] = [];
  const events: unknown[] = [];
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: gateway.factory, log: (line) => logs.push(line) });
  const views: SignInView[] = [];
  kit.onEvent('*', (event) => events.push(event));
  try {
    const unavailable = kit.signIn('ana', { authChoice: 'setup-token' }, (v) => views.push(v));
    unavailable.paste(tokens.ana);
    assert.equal((await unavailable.done).state, 'failed');
    assert.equal(gateway.calls.length, 0, 'readiness failure never sends credentials');
    await kit.start();
    const api = openclawLink(kit, { memberOf: (grant) => grant.name,
      relay: { notify: async (notice: unknown) => { notices.push(notice); return { sent: 1 }; } } as Parameters<typeof openclawLink>[1]['relay'] });
    const grant = (member: string) => ({ id: member, name: member, key: '', role: 'control' as const, created: 0 });
    const results: unknown[] = [];
    await assert.rejects(async () => api.handle!({ op: 'oc.signin.start', args: { provider: 'anthropic', via: 'browser' } }, grant('ana')),
      /can't do that/, 'the unoffered setup-token choice is not reachable through the link');
    for (const member of ['ana', 'bea'] as const) {
      results.push(await api.handle!({ op: 'oc.signin.start', args: { provider: 'github-copilot', via: 'code' } }, grant(member)));
    }
    await turn();
    for (const member of ['bea', 'ana'] as const) {
      results.push(await api.handle!({ op: 'oc.signin.paste', args: { provider: 'github-copilot', text: tokens[member] } }, grant(member)));
    }
    await turn();
    for (const member of ['ana', 'bea'] as const) {
      const result = await api.handle!({ op: 'oc.signin.view', args: { provider: 'github-copilot' } }, grant(member));
      results.push(result);
      assert.equal((result as { view: SignInView }).view.state, member === 'ana' ? 'done' : 'failed');
    }
    assert.deepEqual(received, [{ member: 'bea', value: tokens.bea }, { member: 'ana', value: tokens.ana }]);
    assert.equal(sessions.size, 2);
    for (const token of Object.values(tokens)) assert.ok(!JSON.stringify({ views, results, logs, notices, events }).includes(token));
    assert.deepEqual(notices, [], 'sign-in never creates an approval push');
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('every text step is asked: a plain question as written, a sensitive one only as a fixed label', async (t) => {
  // The pin's real first step for github-copilot-enterprise (2026.8.1): a non-sensitive question, nothing to show but it.
  const enterprise = { id: 'domain', type: 'text', message: 'GitHub Enterprise domain (data residency)', placeholder: 'your-org.ghe.com' };
  const canaries = ['synthetic-question-canary', 'synthetic-later-canary'];
  const cases = [
    { name: 'github-copilot-enterprise', choice: 'github-copilot-enterprise', steps: [enterprise], value: 'umer.ghe.com',
      prompts: ['GitHub Enterprise domain (data residency)'] },
    { name: 'sensitive, then plain', choice: 'custom-provider-choice', value: 'synthetic-secret-canary',
      steps: [{ id: 'secret', type: 'text', sensitive: true, message: canaries[0] }, { id: 'later', type: 'text', message: canaries[1] }],
      prompts: ['Sign-in token', 'Sign-in token'] },
  ];
  for (const c of cases) await t.test(c.name, async () => {
    const stateDir = scratchDir('text-prompt');
    const answers: unknown[] = [];
    const gateway = fakeGateway({
      'openclaw.setup.auth.start': (params) => { assert.equal(params.authChoice, c.choice); return { done: false }; },
      'wizard.next': (params: any) => {
        if (params.answer) answers.push(params.answer);
        return answers.length < c.steps.length ? { done: false, step: c.steps[answers.length] } : { done: true };
      },
      'wizard.cancel': () => ({}),
    });
    const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: gateway.factory });
    try {
      await kit.start();
      const views: SignInView[] = [];
      const handle = kit.signIn('m1', { authChoice: c.choice, via: 'code' }, (v) => views.push(v));
      // The caller answers only what it was asked, as an app would.
      for (const [i] of c.steps.entries()) {
        for (let waited = 0; views.filter((v) => v.prompt).length <= i && waited < 5_000; waited += 5) await delay(5);
        assert.equal(views.filter((v) => v.prompt)[i]?.prompt, c.prompts[i], JSON.stringify(views));
        handle.paste(c.value);
      }
      assert.deepEqual(await handle.done, { state: 'done', via: 'code' });
      assert.deepEqual(answers, c.steps.map((step) => ({ stepId: step.id, value: c.value })));
      if (c.choice !== 'github-copilot-enterprise')
        for (const secret of [...canaries, c.value]) assert.ok(!JSON.stringify(views).includes(secret), secret);
    } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});

test('explicit Anthropic key entry is API billed and never echoed in views or errors', async () => {
  const secret = 'test-secret-not-a-real-key';
  const fake = scripted({
    'openclaw.setup.activate': (params) => {
      assert.deepEqual(params, { agentId: 'm1', kind: 'api-key', authChoice: 'apiKey', apiKey: secret });
      throw new Error(secret);
    },
  });
  const views: SignInView[] = [];
  const drive = signIn(ctx(fake), 'm1', { authChoice: 'apiKey' }, (view) => views.push(view));
  drive.paste(secret);
  assert.equal((await drive.done).state, 'failed');
  assert.equal(views[0]?.prompt, 'API key (billed per use)');
  assert.ok(!JSON.stringify(views).includes(secret));
});

test('a key activation is done only once the restart it causes has finished, however late the restart begins', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const secret = 'test-secret-not-a-real-key';
  const fake = scripted({ 'openclaw.setup.activate': () => ({ ok: true }) });
  // The restart begins 12 s after activation answers and the kit is ready again a second later.
  const restarted = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 13_000));
  const drive = signIn(ctx(fake, { restarted }), 'm1', { authChoice: 'apiKey' }, () => {});
  drive.paste(secret);
  let settled: SignInView | undefined;
  void drive.done.then((view) => { settled = view; });
  await turn();
  t.mock.timers.tick(12_000);
  await turn();
  assert.equal(settled, undefined, 'done is not decided by a fixed window');
  t.mock.timers.tick(1_000);
  assert.deepEqual(await drive.done, { state: 'done', via: 'browser' });
});

test('a key activation whose restart does not finish fails retryably and keeps its words off the key', async () => {
  const secret = 'test-secret-not-a-real-key';
  const fake = scripted({ 'openclaw.setup.activate': () => ({ ok: true }) });
  const drive = signIn(ctx(fake, { restarted: async () => false }), 'm1', { authChoice: 'apiKey' }, () => {});
  drive.paste(secret);
  const view = await drive.done;
  assert.deepEqual(view, { state: 'failed', via: 'browser', why: 'failed',
    error: 'The engine took too long to restart after this sign-in. Nothing was kept; try again.' });
  assert.ok(!JSON.stringify(view).includes(secret));
});

// A fake `claude` in the engine's bin: checks the engine folder, its own login HOME and env, prints a sign-in address, takes one code (`wrong-code` is declined). Status waits for `status-release` unless `held`.
function fakeClaude(root: string, held = false) {
  const bin = join(root, 'bin'), folder = join(realpathSync(root), 'openclaw/home/.claude'), granted = join(folder, 'granted'); mkdirSync(bin, { recursive: true }); writeFileSync(join(root, 'mode'), 'success'); if (!held) writeFileSync(join(root, 'status-release'), '');
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), f = (n) => path.join(${JSON.stringify(root)}, n), folder = ${JSON.stringify(folder)}, granted = path.join(folder, 'granted');
if (process.env.CLAUDE_CONFIG_DIR !== folder || process.env.HOME !== path.join(folder, '../../login-home') || 'OPENCLAW_GATEWAY_TOKEN' in process.env || 'BYOKIT_BRIDGE_SOCK' in process.env) process.exit(3);
if (process.argv[3] === 'status') { fs.writeFileSync(f('status-inflight'), ''); const answer = () => fs.existsSync(f('status-release')) ? (console.log(JSON.stringify({ loggedIn: fs.existsSync(granted) })), process.exit()) : setTimeout(answer, 10); answer(); }
else if (process.argv.slice(2).join(' ') !== 'auth login --claudeai') process.exit(2);
else { fs.appendFileSync(f('logins'), 'login\\n'); console.log('If the browser did not open, visit: https://claude.example.test/authorize');
  if (fs.readFileSync(f('mode'), 'utf8') === 'expired') setTimeout(() => { console.log('code expired'); process.exit(1); }, 200);
  else { process.stdin.setEncoding('utf8'); process.stdin.once('data', (code) => { if (code.trim() === 'wrong-code') { console.log('code declined'); process.exit(1); } fs.writeFileSync(granted, 'signed in'); process.exit(0); }); } }
`, { mode: 0o700 });
  return { bin, folder, granted, logins: join(root, 'logins'), mode: join(root, 'mode'), inflight: join(root, 'status-inflight'), release: join(root, 'status-release') }; }
const grant = { id: 'phone', name: 'Umer', key: '', role: 'control' as const, created: 0 };
const poll = async (done: () => boolean) => { for (let i = 0; !done() && i < 300; i++) await delay(10); return done(); };
// The phone's side of a kit: link calls for one provider, a read of its view, and a wait for a view condition.
const phone = (kit: OpenClawKit, provider = 'claude-cli') => {
  const api = openclawLink(kit, { memberOf: () => 'umer' }), call = (op: string, args: object = {}) => api.handle!({ op, args: { provider, ...args } }, grant);
  const read = () => call('oc.signin.view') as Promise<{ ready: boolean; view: SignInView }>;
  const until = async (done: (view?: SignInView | null) => boolean) => { let v = await read(); for (let i = 0; !done(v.view) && i < 300; i++) { await delay(10); v = await read(); } assert.ok(done(v.view), 'the phone sign-in did not settle'); return v; };
  return { call, read, until }; };
// A kit whose engine bin holds the fake `claude`, over a fake gateway with the scripted methods.
const kitFor = (root: string, script: Parameters<typeof fakeGateway>[0], over: Partial<ConstructorParameters<typeof OpenClawKit>[0]> = {}) => new OpenClawKit({ stateDir: root, enginePath: [join(root, 'bin')], spawnEngine: false, transport: fakeGateway(script).factory, ...over });

test('phone native Claude login uses the engine folder; wrong code, expiry and cancellation never activate', { timeout: 30_000 }, async () => {
  // The stateDir is reached through a symlink, as every path under macOS /tmp and /var is.
  const real = scratchDir('native-phone'), root = `${real}-link`; symlinkSync(real, root); const claude = fakeClaude(root), why: Record<string, string> = { expired: 'expired', cancel: 'declined' };
  let activated = false, release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; }); // Sealed: a sealed engine creates its own home and still reaches the waiting address.
  const kit = kitFor(root, {
    'openclaw.setup.detect': () => ({ candidates: [{ kind: 'claude-cli', credentials: existsSync(claude.granted) }] }),
    'openclaw.setup.activate': async (p) => { assert.equal(p.kind, 'claude-cli'); assert.ok(existsSync(claude.granted)); await hold; activated = true; return { ok: true }; },
    'models.authStatus': () => ({ providers: existsSync(claude.granted) ? ['claude-cli'] : [] }) }, { authSeal: hostKeySeal({ key: new Uint8Array(32).fill(7) }) });
  try { await kit.start(); const { call, read, until } = phone(kit);
    for (const mode of ['wrong', 'expired', 'cancel', 'success']) { writeFileSync(claude.mode, mode); await call('oc.signin.start', { via: 'browser' });
      const waiting = await until((view) => Boolean(view?.url)); assert.equal(waiting.view.url, 'https://claude.example.test/authorize'); assert.match(waiting.view.prompt!, /Paste the code/);
      if (mode === 'cancel') await call('oc.signin.cancel'); else if (mode !== 'expired') await call('oc.signin.paste', { text: mode === 'wrong' ? 'wrong-code' : 'synthetic-returned-code' });
      if (mode === 'success') { assert.ok(await poll(() => existsSync(claude.granted))); assert.equal((await read()).ready, false, 'native credentials are not a completed activation'); release(); }
      const end = await until((view) => view?.state === 'done' || view?.state === 'failed');
      assert.equal(end.view.state, mode === 'success' ? 'done' : 'failed'); assert.equal(activated, mode === 'success'); if (why[mode]) assert.equal(end.view.why, why[mode]);
      assert.ok(existsSync(claude.folder) && !JSON.stringify(end).includes('synthetic-returned-code'), 'cancel keeps the engine folder; the code never shows'); }
    assert.equal((await read()).ready, true, 'readiness is read back through the engine'); assert.deepEqual(await kit.providers('umer'), ['claude-cli']);
  } finally { release(); await kit.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('an earlier phone attempt finishing its committed activation never overwrites the newer attempt', { timeout: 15_000 }, async () => {
  const root = scratchDir('native-superseded'), holds: ((value: { ok: boolean }) => void)[] = [];
  const kit = kitFor(root, { 'openclaw.setup.detect': () => ({ candidates: [{ kind: 'claude-cli', credentials: true }] }), 'openclaw.setup.activate': () => new Promise((resolve) => { holds.push(resolve); }), 'models.authStatus': () => ({ providers: ['claude-cli'] }) });
  try { await kit.start(); const { call, read } = phone(kit);
    await call('oc.signin.start', { via: 'browser' }); assert.ok(await poll(() => holds.length >= 1));
    await call('oc.signin.cancel'); await call('oc.signin.start', { via: 'browser' }); assert.ok(await poll(() => holds.length >= 2)); // a cancel past the commit point leaves attempt one activating
    holds[0]!({ ok: true }); await delay(50); assert.deepEqual(await read(), { ready: false, view: { state: 'waiting', via: 'browser' } }, 'the newer attempt still owns the view');
    holds[1]!({ ok: true }); for (let i = 0; (await read()).view?.state === 'waiting' && i < 300; i++) await delay(10);
    assert.deepEqual(await read(), { ready: true, view: { state: 'done', via: 'browser' } });
  } finally { for (const hold of holds) hold({ ok: true }); await kit.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('an engine shutdown before a key is pasted declines the key-paste sign-in at once', { timeout: 15_000 }, async () => {
  const root = scratchDir('key-phone-shutdown');
  let activated = false;
  const kit = kitFor(root, { 'openclaw.setup.activate': () => { activated = true; return { ok: true }; } });
  try { await kit.start(); const { call, read, until } = phone(kit, 'opencode-go');
    await call('oc.signin.start', { via: 'code' });
    assert.equal((await until((view) => view?.prompt === 'Plan key')).view.prompt, 'Plan key', 'the drive waits for the pasted plan key');
    const stoppedAt = Date.now(); await kit.stop();
    const end = await until((view) => view?.state === 'failed');
    assert.deepEqual(end.view, { state: 'failed', via: 'code', why: 'declined', error: words('signin.cancelled') });
    assert.equal(activated, false, 'a shutdown before the commit point activates nothing');
    assert.ok(Date.now() - stoppedAt < 5_000, 'the shutdown ends the sign-in at once, not at the 15-minute paste timeout');
    assert.equal((await read()).ready, false);
  } finally { await kit.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const action of ['paste', 'cancel', 'shutdown'] as const) test(`native Claude settlement: ${action} after exit`, { timeout: 30_000 }, async () => {
  const root = scratchDir('native-paste-after-exit'), claude = fakeClaude(root, true);
  let activated = false, release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  const kit = kitFor(root, {
    'openclaw.setup.detect': () => ({ candidates: [{ kind: 'claude-cli', credentials: existsSync(claude.granted) }] }),
    'openclaw.setup.activate': async () => { activated = true; await hold; return { ok: true }; },
    'models.authStatus': () => ({ providers: existsSync(claude.granted) ? ['claude-cli'] : [] }) });
  try { await kit.start(); const { call, read, until } = phone(kit); await call('oc.signin.start', { via: 'browser' }); assert.equal((await until((view) => Boolean(view?.url))).view.url, 'https://claude.example.test/authorize');
    await call('oc.signin.paste', { text: 'synthetic-returned-code' }); assert.ok(await poll(() => existsSync(claude.inflight)), 'the CLI exited and its status read is in flight');
    if (action === 'shutdown') { const stopping = kit.stop(); writeFileSync(claude.release, ''); await stopping;
      assert.equal((await until((view) => view?.state === 'failed')).view.state, 'failed', 'shutdown still wins over late native readiness'); assert.equal(activated, false, 'a stopped engine is never activated'); return; }
    await call(action === 'paste' ? 'oc.signin.paste' : 'oc.signin.cancel', { text: 'late-code' }); writeFileSync(claude.release, '');
    if (action === 'cancel') { assert.equal((await until((view) => view?.state === 'failed')).view.why, 'declined', 'a cancel before the commit point declines even a ready native row'); assert.equal(activated, false, 'and never activates it'); return; }
    assert.equal((await until((view) => activated || view?.state === 'failed')).view.state, 'waiting', 'a late paste does not end a ready native row');
    assert.equal(activated, true, 'ready settlement continues into activation'); assert.equal((await read()).ready, false, 'activation still owns completion');
    release(); const end = await until((view) => view?.state === 'done' || view?.state === 'failed');
    assert.equal(end.view.state, 'done'); assert.ok(!JSON.stringify(end).includes('late-code')); assert.equal((await read()).ready, true);
  } finally { writeFileSync(claude.release, ''); release(); await kit.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const action of ['shutdown-ready', 'stale-ready']) test(`native Claude recovery: ${action}`, { timeout: 15_000 }, async () => {
  const root = scratchDir('native-ready-recovery'), claude = fakeClaude(root);
  const engine = new Engine({ stateDir: root, enginePath: [claude.bin], spawnEngine: false, pluginId: 'byokit', tools: [], onState() {}, onExit() {} });
  let seenReady!: () => void, releaseDetect!: () => void, missOnce = false;
  const ready = new Promise<void>((resolve) => { seenReady = resolve; }), detection = new Promise<void>((resolve) => { releaseDetect = resolve; });
  const logins = () => existsSync(claude.logins) ? readFileSync(claude.logins, 'utf8').trim().split('\n').length : 0;
  const fake = scripted({
    'openclaw.setup.detect': async () => { if (missOnce) { missOnce = false; return { candidates: [] }; }
      if (action === 'shutdown-ready' && existsSync(claude.granted)) { seenReady(); await detection; }
      return { candidates: [{ kind: 'claude-cli', credentials: existsSync(claude.granted) && (action !== 'stale-ready' || logins() === 2) }] }; },
    'openclaw.setup.activate': () => { assert.ok(existsSync(claude.granted)); return { ok: true }; } });
  // The launch resolves with its view once the address shows, or with its end if the drive ends first.
  const launch = (context: SignInCtx) => { let shown!: (v: SignInView) => void; const waiting = new Promise<SignInView>((resolve) => { shown = resolve; });
    const handle = signIn(context, 'm1', { authChoice: 'anthropic-cli' }, (v) => { if (v.url) shown(v); }); return { handle, waiting: Promise.race([waiting, handle.done]) }; };
  try { await engine.prepare(); const context = ctx(fake, { nativeClaudeLogin: () => engine.nativeClaudeLogin(), resetNativeClaudeLogin: () => engine.resetNativeClaudeLogin(),
      restarted: async (_, signal) => { assert.ok(signal); assert.equal(signal.aborted, false); return true; } });
    const first = launch(context); assert.equal((await first.waiting).state, 'waiting'); first.handle.paste('synthetic-code');
    if (action === 'shutdown-ready') {
      await ready; // Native wait settled ready; only the independent engine detection is held.
      const native = engine.nativeClaudeLogin(); const stopping = engine.stop(); releaseDetect(); // Real engine lifecycle, while the scripted gateway is still reachable.
      assert.equal((await first.handle.done).state, 'failed'); await stopping;
      assert.equal(native.signal.aborted, true); assert.ok(!fake.methods().includes('openclaw.setup.activate'), 'shutdown beginning prevents activation after readiness');
    } else {
      assert.equal((await first.handle.done).state, 'failed', 'engine and native readiness disagree'); assert.equal(logins(), 1);
      const second = launch(context); assert.equal((await second.waiting).state, 'waiting', 'stale ready bookkeeping must not trap the phone at already');
      assert.equal(readFileSync(claude.granted, 'utf8'), 'signed in', "the fake's own marker file survives the reset");
      second.handle.paste('synthetic-code'); assert.equal((await second.handle.done).state, 'done'); assert.equal(logins(), 2, 'one fresh login, never an automatic loop');
      assert.equal(fake.methods().filter((m) => m === 'openclaw.setup.activate').length, 1);
      missOnce = true; // start sees already, then the independent engine detection succeeds.
      assert.equal((await launch(context).handle.done).state, 'done', 'a usable already row activates without logging in again'); assert.equal(logins(), 2);
    }
  } finally { releaseDetect(); await engine.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('a phone cancel before the commit point activates nothing; after it the engine answer decides', { timeout: 15_000 }, async (t) => {
  for (const row of ['before detection', 'during detection', 'restart confirmed', 'restart late'] as const) await t.test(row, async () => {
    const root = scratchDir('native-commit'), granted = join(root, 'granted'); writeFileSync(granted, 'signed in');
    const seen: { answerDetect?: (value: unknown) => void; detectSignal?: AbortSignal; finishRestart?: (ok: boolean) => void } = {};
    const fake = scripted({
      'openclaw.setup.detect': (_, o) => row === 'during detection' ? new Promise((resolve) => { seen.answerDetect = resolve; seen.detectSignal = o.signal; }) : { candidates: [{ kind: 'claude-cli', credentials: true }] },
      'openclaw.setup.activate': () => ({ ok: true }) });
    const drive = signIn(ctx(fake, { restarted: () => new Promise<boolean>((resolve) => { seen.finishRestart = resolve; }) }), 'm1', { authChoice: 'anthropic-cli' }, () => {});
    const activating = row.startsWith('restart');
    if (row === 'during detection') { assert.ok(await poll(() => Boolean(seen.answerDetect)), 'detection is pending when the phone cancels');
      drive.cancel(); assert.equal(seen.detectSignal?.aborted, true, 'the cancel aborts the pending detection'); seen.answerDetect!({ candidates: [{ kind: 'claude-cli', credentials: true }] }); }
    else if (activating) { assert.ok(await poll(() => Boolean(seen.finishRestart)), 'the route is activated and its restart is pending'); drive.cancel(); seen.finishRestart!(row === 'restart confirmed'); } else drive.cancel();
    assert.deepEqual(await drive.done, row === 'restart confirmed' ? { state: 'done', via: 'browser' }
      : row === 'restart late' ? { state: 'failed', via: 'browser', why: 'failed', error: words('signin.savedNotRestarted') } : { state: 'failed', via: 'browser', why: 'declined', error: words('signin.cancelled') });
    assert.equal(fake.methods().includes('openclaw.setup.activate'), activating, 'only a cancel after the commit point leaves an activation');
    assert.equal(readFileSync(granted, 'utf8'), 'signed in', 'the native grant is kept');
  }); });

