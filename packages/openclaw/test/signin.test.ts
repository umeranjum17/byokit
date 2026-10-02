// The sign-in wizard drive against the contract the pinned gateway speaks (5.7): steps come only from wizard.next,
// every exit short of done cancels this task's own session, and the browser route holds the callback port itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { providers, signIn, signOut, type SignInCtx } from '../src/signin.ts';
import { OpenClawKit } from '../src/kit.ts';
import { scratchDir } from '../../test-support.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
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

test('auth reload: a local paste wait or flushed/orphaned answer is reconfirmed for only the selected agent', async (t) => {
  for (const wait of ['paste', 'flushed', 'orphaned', 'approval'] as const) await t.test(wait, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let disconnect: (() => void) | undefined;
    let stored = false;
    let rejectAnswer: ((error: Error) => void) | undefined;
    let terminal: SignInView | undefined;
    const fake = scripted({
      'models.authStatus': (params) => {
        assert.equal(params.agentId, 'selected');
        return { providers: stored ? [{ provider: 'openai', profiles: [
          { profileId: 'openai:selected', type: 'oauth', status: 'ok', expiry: { at: Date.now() + 999_999 } },
        ] }] : [] };
      },
      'openclaw.setup.auth.start': () => ({ done: false }),
      'wizard.next': (params, options) => {
        if (!params.answer) return { step: wait === 'approval' ? DEVICE_STEP
          : { id: 'login', type: wait === 'paste' ? 'text' : 'note', externalUrl: 'https://example.test/signin' } };
        assert.equal(options.timeoutMs, wait === 'approval' ? null : 120_000);
        return new Promise((_resolve, reject) => {
          rejectAnswer = reject;
          // Model the pinned client: numeric requests time out and close flush rejects, not an immortal RPC.
          const timer = options.timeoutMs === null ? undefined
            : setTimeout(() => reject(new Error('request timed out')), options.timeoutMs);
          options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
        });
      },
      'wizard.cancel': () => ({}),
    });
    const via = wait === 'approval' ? 'code' : 'browser';
    const handle = signIn(ctx(fake, { onDisconnect: (fn) => { disconnect = fn; return () => { disconnect = undefined; }; } }),
      'selected', { authChoice: wait === 'approval' ? 'openai-device-code' : 'openai', via },
      (view) => { if (view.state !== 'waiting') terminal = view; });
    await turn();
    stored = true; // the engine commits credentials, then SIGUSR1 destroys its in-memory wizard
    if (wait === 'flushed') rejectAnswer?.(new Error('gateway closed (1012): service restart'));
    disconnect?.();
    await turn();
    // A 186s observation does not imply an immortal RPC: paste waits have their own 15 minute clock.
    t.mock.timers.tick(186_000);
    await turn();
    try {
      assert.deepEqual(terminal, { state: 'done', via });
      assert.deepEqual(await handle.done, terminal);
      assert.equal(disconnect, undefined, 'the restart listener is released');
    } finally { handle.cancel(); await handle.done; }
  });
});

test('auth reload: restart, unrelated/old accounts, pending credentials, errors and cancellation never imply done', async (t) => {
  const ready = { provider: 'openai', profiles: [
    { profileId: 'openai:selected', type: 'oauth', status: 'ok', expiry: { at: Date.now() + 999_999 } },
  ] };
  const cases = ['missing', 'pending', 'other-provider', 'unchanged', 'unavailable', 'read-error', 'read-stalled',
    'cancel', 'abort', 'no-restart', 'wizard-error', 'unknown-before', 'api-key', 'expired', 'refreshed-existing', 'device-expiry', 'legacy-before', 'unknown-profiles-before'] as const;
  for (const scenario of cases) await t.test(scenario, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let disconnect: (() => void) | undefined;
    let reloaded = false;
    let reads = 0;
    const controller = new AbortController();
    const fake = scripted({
      'models.authStatus': (params) => {
        assert.equal(params.agentId, 'selected', 'no fallback to main or another member');
        reads++;
        if (!reloaded) return scenario === 'unknown-before' ? {}
          : scenario === 'legacy-before' ? { providers: ['openai'] }
          : scenario === 'unknown-profiles-before' ? { providers: [{ provider: 'openai', status: 'ok' }] }
          : { providers: scenario === 'unchanged' ? [ready]
          : scenario === 'refreshed-existing' ? [{ ...ready, profiles: [{ ...ready.profiles[0], status: 'expired',
            expiry: { at: Date.now() - 1 } }] }] : [] };
        if (scenario === 'read-error') throw new Error('unavailable');
        if (scenario === 'read-stalled') return new Promise(() => {});
        if (scenario === 'unavailable') return { unavailable: {}, providers: [ready] };
        const row = scenario === 'other-provider' ? { ...ready, provider: 'other' }
          : scenario === 'pending' || scenario === 'device-expiry' ? { ...ready, profiles: [{ ...ready.profiles[0], status: 'pending' }] }
          : scenario === 'api-key' ? { ...ready, profiles: [{ ...ready.profiles[0], type: 'api_key', status: 'static' }] }
          : scenario === 'expired' ? { ...ready, profiles: [{ ...ready.profiles[0], expiry: { at: Date.now() - 1 } }] }
          : ready;
        return { providers: scenario === 'missing' ? [] : [row] };
      },
      'openclaw.setup.auth.start': () => ({ done: false }),
      'wizard.next': (params) => scenario === 'wizard-error' ? { done: true, status: 'error', error: 'login denied' }
        : scenario === 'device-expiry' ? params.answer ? new Promise(() => {})
          : { step: { ...DEVICE_STEP, deviceCode: { code: 'TEST', expires_in: 1 } } }
        : { step: { id: 'manual', type: 'text' } },
      'wizard.cancel': () => ({}),
    });
    const views: SignInView[] = [];
    const handle = signIn(ctx(fake, { onDisconnect: (fn) => { disconnect = fn; return () => { disconnect = undefined; }; } }),
      'selected', { authChoice: scenario === 'device-expiry' ? 'openai-device-code' : 'openai', signal: controller.signal },
      (v) => views.push(v));
    await turn();
    reloaded = true;
    if (scenario !== 'no-restart' && scenario !== 'wizard-error') disconnect?.();
    if (scenario === 'cancel' || scenario === 'no-restart') handle.cancel();
    if (scenario === 'abort') controller.abort();
    await turn();
    t.mock.timers.tick(60_000);
    await turn();
    const end = await handle.done;
    assert.equal(end.state, 'failed');
    if (scenario === 'device-expiry') assert.equal(end.why, 'expired');
    assert.equal(views.filter((v) => v.state === 'done').length, 0);
    assert.equal(disconnect, undefined);
    if (scenario === 'no-restart') assert.equal(reads, 1, 'no background polling without a disconnect');
    assert.equal(fake.calls.filter((c) => c.method === 'wizard.cancel').length, 1);
  });
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

test('a flushed RPC or cancellation still settles exactly once when reconnect cleanup throws synchronously', async (t) => {
  for (const scenario of ['flushed', 'cancel'] as const) await t.test(scenario, async () => {
    const fake = scripted({
      'openclaw.setup.auth.start': () => ({ done: false }),
      'wizard.next': (_params, options) => {
        if (scenario === 'flushed') throw new Error('gateway closed (1012): service restart');
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    const request: GatewayTransport['request'] = (method, params, options) => {
      // The kit facade throws synchronously from request() after closed() has cleared its live transport.
      if (method === 'wizard.cancel') throw new Error('gateway not ready');
      return fake.request(method, params, options);
    };
    const terminals: SignInView[] = [];
    const handle = signIn(ctx(fake, { request }), 'selected', { authChoice: 'openai-device-code', via: 'code' },
      (v) => { if (v.state !== 'waiting') terminals.push(v); });
    await turn();
    if (scenario === 'cancel') handle.cancel();
    await turn();
    assert.equal(terminals.length, 1, 'cleanup failure must not strand or duplicate the terminal view');
    assert.equal((await handle.done).why, scenario === 'cancel' ? 'declined' : 'failed');
    handle.cancel();
    await turn();
    assert.equal(terminals.length, 1);
  });
});

test('sign-in: the device code is pulled and shown, and the card finishes when the engine does', async () => {
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ sessionId: 'byokit-fake-1', done: false, status: 'running' }),
    'wizard.next': (() => {
      let answered = false, waiting = 0;
      return (params: any) => {
        if (params.answer) { answered = true; return { done: false, step: { id: 'step-wait', type: 'progress', message: 'Waiting', executor: 'gateway' } }; }
        if (!answered) return { done: false, step: DEVICE_STEP };
        if (waiting++ === 0) return { done: false, step: { id: 'step-wait', type: 'progress', message: 'Waiting', executor: 'gateway' } };
        return { done: true, status: 'done', modelActivation: { modelRef: 'openai/gpt-5.1' } };
      };
    })(),
  });
  const views: SignInView[] = [];
  const handle = signIn(ctx(fake), 'm1', { authChoice: 'openai-device-code', via: 'code' }, (view) => views.push(view));
  const end = await handle.done;
  assert.deepEqual(end, { state: 'done', via: 'code' });
  assert.equal(fake.methods().filter((m, i, all) => all.indexOf(m) === i).join(','), 'openclaw.setup.auth.start,wizard.next',
    'the drive pulls steps; wizard.status is not part of it');
  assert.ok(!fake.methods().includes('wizard.status'), 'wizard.status never carries a step and is never called');
  assert.match(fake.calls[0]!.params.sessionId, /^byokit-/);
  assert.equal(fake.calls[0]!.params.authChoice, 'openai-device-code');
  assert.equal(fake.calls[0]!.params.agentId, 'm1');
  assert.ok(views.some((view) => view.state === 'waiting' && view.code === 'CREW-2026' && view.url === DEVICE_STEP.externalUrl),
    `no device code was shown: ${JSON.stringify(views)}`);
  assert.equal(fake.calls.find((call) => call.params?.answer)?.params.answer.stepId, 'step-device');
  assert.equal(fake.methods().filter((m) => m === 'openclaw.setup.auth.start').length, 1, 'the session is started once');
});

// Model the real transport's timeout and signal while the engine holds wizard.next for approval.
function approvalGateway(afterMs: number, deviceCode: Record<string, unknown> = { code: 'UMER-2026', expiresInMinutes: 15 }, progress = false) {
  let shown = false;
  return scripted({
    'openclaw.setup.auth.start': () => ({ done: false }),
    'wizard.cancel': () => ({ status: 'cancelled' }),
    'wizard.next': (params: any, options?: any) => {
      if (!shown) { shown = true; return { step: { ...DEVICE_STEP, deviceCode } }; }
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

test('without an expiry field the engine owns the device deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = approvalGateway(181_000, { code: 'UMER-2026' });
  const handle = signIn(ctx(fake), 'umer', { authChoice: 'openai-device-code', via: 'code' }, () => {});
  await turn();
  t.mock.timers.tick(181_000);
  assert.equal((await handle.done).state, 'done');
});

test('ordinary wizard steps still use the short request timeout', async () => {
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ done: false }),
    'wizard.next': (params: any, options?: any) => {
      assert.equal(options.timeoutMs, 120_000);
      return params.answer ? { done: true } : { step: { id: 'ordinary', type: 'note' } };
    },
  });
  assert.equal((await signIn(ctx(fake), 'umer', { authChoice: 'openai-device-code', via: 'code' }, () => {}).done).state, 'done');
});

test('provider expiry after a help note is still typed expired', async () => {
  let pulls = 0;
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ done: false }),
    'wizard.cancel': () => ({}),
    'wizard.next': () => ++pulls === 1 ? { step: DEVICE_STEP }
      : pulls === 2 ? { step: { id: 'help', type: 'note' } }
      : { done: true, status: 'error', error: 'OpenAI device authorization timed out after 15 minutes.' },
  });
  assert.equal((await signIn(ctx(fake), 'umer', { authChoice: 'openai-device-code', via: 'code' }, () => {}).done).why, 'expired');
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

test('sign-in: giving up cancels its own wizard session, so a retry is not locked out', async () => {
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ done: false }),
    'wizard.next': () => ({ done: false }), // a wizard that never yields a step: the drive runs out its budget
    'wizard.cancel': () => ({ status: 'cancelled' }),
  });
  const end = await signIn(ctx(fake), 'm1', { authChoice: 'openai-device-code', via: 'code' }, () => {}).done;
  assert.equal(end.state, 'failed');
  assert.equal(end.why, 'expired');
  // The session id is the client's own (5.7), so this is the one and only id the drive can cancel.
  const cancels = fake.calls.filter((call) => call.method === 'wizard.cancel');
  assert.deepEqual(cancels.map((call) => call.params?.sessionId), [fake.calls[0]!.params.sessionId], 'only this task-owned session is cancelled');
  assert.match(String(cancels[0]!.params?.sessionId), /^byokit-/);
});

test('sign-in: the person cancels, and this session is the one cancelled', async () => {
  let pulls = 0;
  const fake = scripted({
    'openclaw.setup.auth.start': () => ({ done: false }),
    'wizard.next': (_params: any, options?: any) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ done: false, step: { id: `p${pulls++}`, type: 'progress', message: 'polling' } }), 5_000);
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }),
    'wizard.cancel': () => ({ status: 'cancelled' }),
  });
  const views: SignInView[] = [];
  const handle = signIn(ctx(fake), 'm1', { authChoice: 'openai-device-code', via: 'code' }, (view) => views.push(view));
  await delay(50);
  handle.cancel();
  const end = await handle.done;
  assert.deepEqual(end, { state: 'failed', via: 'code', why: 'declined', error: words('signin.cancelled') });
  assert.deepEqual(views.at(-1), end, 'the card is told how it ended');
  assert.deepEqual(fake.calls.filter((call) => call.method === 'wizard.cancel').map((call) => call.params?.sessionId),
    [fake.calls[0]!.params.sessionId]);
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

test('sign-in: a cancel waits for the start to settle, then cancels that session once (N5)', async () => {
  const log: string[] = [];
  const calls: { method: string; params?: any }[] = [];
  let settleStart!: () => void;
  const startSettles = new Promise<void>((resolve) => { settleStart = resolve; });
  const request: GatewayTransport['request'] = async (method, params, options) => {
    calls.push({ method, params: params as any });
    if (method === 'openclaw.setup.auth.start') {
      // The pinned client's rules: the start is never aborted, and a cancel sent before it settles is not found.
      assert.ok(options?.signal === undefined, 'the start request carries no abort signal');
      await startSettles;
      log.push('start settled');
      return { done: false };
    }
    if (method === 'wizard.next') { log.push('next'); throw new Error('aborted'); }
    if (method === 'wizard.cancel') { log.push('cancel'); return { status: 'cancelled' }; }
    return {};
  };
  const handle = signIn({ request, ensure: async (member) => ({ agentId: member }), callbackPort: 0 },
    'm1', { authChoice: 'openai-device-code', via: 'code' }, () => {});
  await delay(20);
  handle.cancel(); // at 0: before the engine has registered the session
  await delay(20);
  assert.deepEqual(log, [], 'nothing is sent while the session does not exist yet');
  settleStart();
  assert.equal((await handle.done).why, 'declined', 'the person\'s exit is still the card\'s answer');
  assert.deepEqual(log, ['start settled', 'cancel'], 'the session is cancelled only once it exists');
  const cancels = calls.filter((call) => call.method === 'wizard.cancel');
  assert.equal(cancels.length, 1, 'one cancel, late enough for the engine to find it');
  assert.equal(cancels[0]!.params.sessionId, calls[0]!.params.sessionId);
  assert.match(String(cancels[0]!.params.sessionId), /^byokit-/);
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

test('providers reads both entry shapes, dedupes, and signOut names the provider and agent', async () => {
  const fake = scripted({
    'models.authStatus': (params: any) => ({
      providers: params.refresh
        ? ['openai', { provider: 'xai' }, { provider: 'openai' }, '', { nothing: true }]
        : [{ provider: 'openai' }],
    }),
    'models.authLogout': () => ({}),
  });
  assert.deepEqual(await providers(ctx(fake), 'm1'), ['openai']);
  assert.deepEqual(await providers(ctx(fake), 'm1', true), ['openai', 'xai']);
  assert.deepEqual(fake.calls.filter((call) => call.method === 'models.authStatus')[1]!.params, { agentId: 'm1', refresh: true });
  await signOut(ctx(fake), 'm1', 'openai');
  assert.deepEqual(fake.calls.at(-1), { method: 'models.authLogout', params: { provider: 'openai', agentId: 'm1' } });
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

test('Claude Code sign-in uses engine detection and activation, never an OAuth wizard or credentials', async () => {
  const fake = scripted({
    'openclaw.setup.detect': () => ({ candidates: [{ kind: 'claude-cli', credentials: true }] }),
    'openclaw.setup.activate': (params) => { assert.deepEqual(params, { agentId: 'm1', kind: 'claude-cli' }); return { ok: true }; },
  });
  assert.deepEqual(await signIn(ctx(fake), 'm1', { authChoice: 'anthropic-cli' }, () => {}).done,
    { state: 'done', via: 'browser' });
  assert.deepEqual(fake.methods(), ['openclaw.setup.detect', 'openclaw.setup.activate']);
});

test('Claude Code login missing or unknown refuses activation and asks for the native login', async () => {
  for (const credentials of [false, undefined]) {
    const fake = scripted({ 'openclaw.setup.detect': () => ({ candidates: [{ kind: 'claude-cli', credentials }] }) });
    const result = await signIn(ctx(fake), 'm1', { authChoice: 'anthropic-cli' }, () => {}).done;
    assert.equal(result.state, 'failed');
    assert.match(result.error!, /login stays in Claude Code/);
    assert.deepEqual(fake.methods(), ['openclaw.setup.detect']);
  }
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
