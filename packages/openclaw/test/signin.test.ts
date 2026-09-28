// The sign-in wizard drive against the contract the pinned gateway speaks (5.7): steps come only from wizard.next,
// every exit short of done cancels this task's own session, and the browser route holds the callback port itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  assert.deepEqual(end, { state: 'failed', via: 'code', why: 'declined' });
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
  assert.deepEqual(fake.calls[1]!.params, { agentId: 'm1', refresh: true });
  await signOut(ctx(fake), 'm1', 'openai');
  assert.deepEqual(fake.calls.at(-1), { method: 'models.authLogout', params: { provider: 'openai', agentId: 'm1' } });
});

test('providers does not invent a sign-in when the engine refuses to answer', async () => {
  const fake = scripted({ 'models.authStatus': () => { throw new Error('gateway is busy'); } });
  await assert.rejects(providers(ctx(fake), 'm1'), /gateway is busy/);
});

test('the kit drives the same flow through its own transport and members (5.3)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o6-facade-'));
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
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o6-facade-migrate-'));
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
