import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as turn } from 'node:timers/promises';
import { browserHostContract, fakeBrowserHost, memorySignInStore, type FakeBrowserHost } from '../../src/testing/browser.ts';
import { createBrowserHost, HandoffUnprotected, SignInRefused, type HostBroker, type BrowserHostServices } from '../../src/browser/host.ts';
import { emptySignIns, fileSignInStore, type SignInStore } from '../../src/browser/store.ts';
import type { LiveViewState } from '../../src/browser.ts';
import { verifySignIn } from '../../src/browser/verify.ts';

const raise = (host: FakeBrowserHost, member = 'ada') => host.raise({ member, sessionKey: `session:${member}:task`,
  checkUrl: 'http://127.0.0.1:2820/task', reasons: ['agent-asked'] });
async function held(host: FakeBrowserHost) {
  const r = await raise(host);
  const lease = await host.takeover(r.id, r.gen, { grant: 'control', confirmSite: r.site });
  return { r, lease };
}
const refused = (why: string) => (e: unknown) => e instanceof SignInRefused && e.why === why;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

for (const durable of [false, true]) test(`public host contract: ${durable ? 'fsync durable' : 'in-memory'} synthetic broker`, async () => {
  const dir = durable ? mkdtempSync(join(tmpdir(), 'h2b-')) : undefined;
  const host = await fakeBrowserHost({ store: dir ? fileSignInStore(dir) : memorySignInStore() });
  try {
    await browserHostContract({ host, raise: () => raise(host), signedIn: () => host.fixture.authenticated('ada', true), dispatches: () => host.fixture.dispatches.length });
    assert.deepEqual(host.fixture.parked, [{ member: 'ada', sessionKey: 'session:ada:task' }]);
    const r = host.signIns()[0];
    assert.equal(host.fixture.dispatches[0].idempotencyKey, r.settled?.resume?.key);
    assert.equal(host.fixture.privateOpen('ada'), false);
    const calls = host.fixture.calls;
    assert.ok(calls.lastIndexOf('ada:close') < calls.lastIndexOf('ada:fence:false'));
    if (dir) {
      const file = join(dir, 'browser/signins.json');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).requests[0].settled.resume.key, r.settled?.resume?.key);
    }
  } finally { await host.close(); if (dir) rmSync(dir, { recursive: true, force: true }); }
});

test('production handoff cannot be enabled by an option/type assertion; viewing is independent', async () => {
  const fixture = await fakeBrowserHost();
  const host = await createBrowserHost({ brokers: new Map([['ada', fixture.fixture.broker('ada')]]), store: memorySignInStore(),
    options: { executablePath: '/synthetic/chromium', members: ['ada'] }, authorize: () => true,
    park: async () => { assert.fail('production must not park'); }, resume: async () => { assert.fail('production must not resume'); }, siteOf: () => '127.0.0.1' });
  try {
    assert.equal(host.state('ada').why, 'handoff-unprotected');
    await assert.rejects(host.raise({ member: 'ada', sessionKey: 's', checkUrl: 'http://127.0.0.1:2820', reasons: ['agent-asked'] }), HandoffUnprotected);
    assert.equal(host.signIns().length, 0);
    assert.equal((await host.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'view' })).state, 'ok');
    const states: LiveViewState[] = [];
    const stream = host.live({ kind: 'browser', member: 'ada' }, { grant: 'view' }, { state: s => states.push(s), frame() {} });
    await turn(); assert.ok(states.some(s => s.phase === 'live')); stream.close();
  } finally { await host.close(); await fixture.close(); }
});

test('anonymous clean 200 and missing/status-only verifier are never verified', async () => {
  for (const verifiers of [[], [{ origin: 'http://127.0.0.1:2820', url: 'http://127.0.0.1:2820/account', status: 200 }]]) {
    const host = await fakeBrowserHost({ options: { verifiers } });
    try {
      const { lease } = await held(host); host.fixture.authenticated('ada', true);
      const r = await host.done(lease);
      assert.deepEqual({ state: r.settled?.state, reason: r.settled?.reason }, { state: 'entered-unverified', reason: 'no-verifier' });
      assert.equal(host.fixture.dispatches.length, 0);
    } finally { await host.close(); }
  }
  const host = await fakeBrowserHost();
  try { const { lease } = await held(host); const r = await host.done(lease); assert.equal(r.settled?.reason, 'still-signed-out'); assert.equal(host.fixture.dispatches.length, 0); }
  finally { await host.close(); }
});

test('verification timeout is bounded, closes private targets, never dispatches', async () => {
  const host = await fakeBrowserHost({ options: { checkMs: 5 } });
  try {
    const { lease } = await held(host); const wait = deferred();
    host.fixture.probe('ada', async () => { await wait.promise; return 'ok'; });
    const r = await host.done(lease); wait.resolve();
    assert.equal(r.settled?.reason, 'check-timeout'); assert.equal(host.fixture.privateOpen('ada'), false); assert.equal(host.fixture.dispatches.length, 0);
  } finally { await host.close(); }
});

test('out-of-order Done/Cancel settle exactly once and stale gen/epoch/nonce are refused', async () => {
  const host = await fakeBrowserHost();
  try {
    const { r, lease } = await held(host);
    await assert.rejects(host.done({ ...lease, epoch: lease.epoch + 1 }), refused('stale'));
    await assert.rejects(host.done({ ...lease, nonce: 'wrong' }), refused('stale'));
    await assert.rejects(host.cancel(r.id, r.gen + 1, { grant: 'control' }), refused('stale'));
    await assert.rejects(host.cancel(r.id, r.gen, { grant: 'other' }), refused('not-lease-holder'));
    host.fixture.authenticated('ada', true);
    const results = await Promise.allSettled([host.done(lease), host.cancel(r.id, r.gen, { grant: 'control' })]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(host.signIns()[0].settled?.state, 'verified'); assert.equal(host.fixture.dispatches.length, 1);
  } finally { await host.close(); }
});

test('revoke synchronously kills grant/streams/input before close barrier; fence held until newgen', async () => {
  const host = await fakeBrowserHost();
  try {
    const { r, lease } = await held(host); const wait = deferred();
    const states: LiveViewState[] = [];
    const stream = host.live({ kind: 'browser', member: 'ada' }, { grant: 'control', lease }, { state: s => states.push(s), frame() {} });
    await turn(); host.fixture.closePrivate('ada', () => wait.promise);
    const revoked = host.revokeGrant('control');
    assert.equal(states.at(-1)?.phase, 'ended');
    assert.throws(() => stream.input({ kind: 'text', text: 'synthetic-secret' }), refused('stale'));
    assert.throws(() => host.confirmOrigin(lease, r.origin), refused('stale'));
    await assert.rejects(host.takeover(r.id, r.gen, { grant: 'other', confirmSite: r.site }), refused('held-by-other'));
    assert.equal(host.signIns()[0].state, 'held'); assert.equal(host.fixture.fenced('ada'), true);
    await turn(); assert.equal(host.fixture.privateOpen('ada'), true);
    wait.resolve(); await revoked;
    const next = host.signIns()[0]; assert.equal(next.state, 'waiting'); assert.equal(next.gen, r.gen + 1);
    assert.equal(host.fixture.privateOpen('ada'), false); assert.equal(host.fixture.fenced('ada'), true);
    await assert.rejects(host.takeover(next.id, next.gen, { grant: 'control', confirmSite: next.site }), refused('not-control'));
  } finally { await host.close(); }
});

test('revoke close failure never returns waiting or grants reuse', async () => {
  const host = await fakeBrowserHost();
  try {
    const { r } = await held(host);
    host.fixture.closePrivate('ada', async () => { throw new Error('synthetic failure'); });
    await host.revokeGrant('control');
    assert.equal(host.signIns()[0].settled?.reason, 'browser-gone'); assert.equal(host.fixture.fenced('ada'), true);
    assert.equal(host.state('ada').why, 'recovery-exhausted');
    await assert.rejects(host.takeover(r.id, r.gen, { grant: 'other', confirmSite: r.site }));
  } finally { await host.close(); }
});

test('exact-origin SSO guard, TLS refusal, private view and input never persist values', async () => {
  const store = memorySignInStore(); const host = await fakeBrowserHost({ store, options: { knownIdps: ['https://idp.example'] } });
  try {
    const { r, lease } = await held(host);
    assert.equal((await host.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'view' })).state, 'private');
    const stream = host.live({ kind: 'browser', member: 'ada' }, { grant: 'control', lease }, { state() {}, frame() {} });
    await turn();
    stream.input({ kind: 'text', text: 'synthetic-secret' }); assert.equal(host.fixture.inputCount('ada'), 1);
    for (const origin of ['https://sibling.idp.example', 'https://idp.example:444', 'http://idp.example']) {
      host.fixture.navigate('ada', origin); stream.input({ kind: 'text', text: 'synthetic-secret' }); assert.equal(host.fixture.inputCount('ada'), 1);
    }
    assert.throws(() => host.confirmOrigin(lease, 'http://idp.example'), refused('insecure-remote'));
    host.fixture.navigate('ada', 'https://tenant.example');
    assert.throws(() => host.confirmOrigin(lease, 'https://other.example'), refused('stale'));
    host.confirmOrigin(lease, 'https://tenant.example'); stream.input({ kind: 'text', text: 'synthetic-secret' });
    assert.equal(host.fixture.inputCount('ada'), 2); assert.doesNotMatch(JSON.stringify(store.read()), /synthetic-secret/);
    stream.close(); await host.cancel(r.id, r.gen, { grant: 'control' });
    host.fixture.navigate('ada', 'http://remote.example');
    const insecure = await raise(host);
    assert.equal(insecure.secure, false); assert.equal(insecure.choices.some(c => c.kind === 'takeover'), false);
    await assert.rejects(host.takeover(insecure.id, insecure.gen, { grant: 'control', confirmSite: insecure.site }), refused('insecure-remote'));
  } finally { await host.close(); }
});

test('claim/grace lapse and expiry close private tabs without an automatic resume', async () => {
  const host = await fakeBrowserHost({ options: { claimMs: 10, graceMs: 10, requestTtlMs: 100 } });
  try {
    const { r, lease } = await held(host); await host.fixture.advance(11);
    const next = host.signIns()[0]; assert.equal(next.state, 'waiting'); assert.equal(next.gen, r.gen + 1);
    await assert.rejects(host.done(lease), refused('stale')); assert.equal(host.fixture.fenced('ada'), true);
    const fresh = await host.takeover(next.id, next.gen, { grant: 'control', confirmSite: next.site });
    const stream = host.live({ kind: 'browser', member: 'ada' }, { grant: 'control', lease: fresh }, { state() {}, frame() {} });
    await turn(); stream.close(); await host.fixture.advance(11);
    assert.equal(host.signIns()[0].gen, next.gen + 1);
    await host.fixture.advance(100); assert.equal(host.signIns()[0].settled?.state, 'expired'); assert.equal(host.fixture.dispatches.length, 0);
  } finally { await host.close(); }
});

test('Not now parks without polling; reopen repeats park/fence; new run replaces parked task', async () => {
  const host = await fakeBrowserHost();
  try {
    const { r } = await held(host); const parked = await host.notNow(r.id, r.gen, { grant: 'control' });
    assert.equal(parked.state, 'parked'); assert.equal(host.fixture.privateOpen('ada'), false);
    await host.fixture.advance(2_000_000); assert.equal(host.signIns()[0].state, 'parked');
    const reopened = await host.reopen(parked.id, parked.gen, { grant: 'control' });
    assert.equal(reopened.gen, parked.gen + 1); assert.equal(host.fixture.parked.length, 2);
    assert.equal(await host.beforeRun('ada', r.sessionKey), false);
    await host.notNow(reopened.id, reopened.gen, { grant: 'control' });
    assert.equal(await host.beforeRun('ada', r.sessionKey), true); assert.equal(host.signIns()[0].settled?.reason, 'run-replaced');
    const retry = await host.retry(r.id, reopened.gen, { grant: 'control' }); assert.equal(retry.prev, r.id);
  } finally { await host.close(); }
});

for (const state of ['waiting', 'held', 'parked', 'checking'] as const) test(`restart ${state}: no stale lease or redispatch`, async () => {
  const store = memorySignInStore(); const host = await fakeBrowserHost({ store });
  const r = await raise(host);
  if (state !== 'waiting') await host.takeover(r.id, r.gen, { grant: 'control', confirmSite: r.site });
  if (state === 'parked') await host.notNow(r.id, r.gen, { grant: 'control' });
  if (state === 'checking') { const data = store.read(); data.requests[0].state = 'checking'; store.write(data); }
  await host.close();
  const restored = await fakeBrowserHost({ store });
  try {
    const next = restored.signIns()[0];
    if (state === 'waiting' || state === 'parked') { assert.equal(next.state, state); assert.equal(next.gen, r.gen + 1); }
    else { assert.equal(next.settled?.reason, 'browser-gone'); }
    assert.equal(restored.fixture.dispatches.length, 0);
  } finally { await restored.close(); }
});

for (const outcome of ['unknown', 'throw', 'refused', 'accepted'] as const) test(`resume ${outcome}: durable key before submission, never automatic retry`, async () => {
  const store = memorySignInStore(); const host = await fakeBrowserHost({ store });
  let persisted = false;
  const original = store.write;
  store.write = data => { original(data); if (data.requests[0]?.settled?.resume?.state === 'pending') persisted = true; };
  try {
    const { lease } = await held(host); host.fixture.authenticated('ada', true); host.fixture.resumeOutcome(outcome);
    const r = await host.done(lease); assert.equal(persisted, true);
    assert.equal(r.settled?.resume?.state, outcome === 'refused' ? 'failed' : outcome === 'accepted' ? 'accepted' : 'indeterminate');
    assert.equal(host.fixture.dispatches.length, 1);
  } finally { await host.close(); }
  const restored = await fakeBrowserHost({ store });
  try { assert.equal(restored.fixture.dispatches.length, 0); assert.equal(restored.signIns()[0].settled?.resume?.state, outcome === 'refused' ? 'failed' : 'indeterminate'); }
  finally { await restored.close(); }
});

test('fsync failure before pending marker prevents dispatch, leaves host blocked and errors redacted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h2b-')); let fail = false;
  const { fsyncSync } = await import('node:fs');
  const store = fileSignInStore(dir, { sync: fd => { if (fail) throw new Error('synthetic-secret'); fsyncSync(fd); } });
  const write = store.write;
  store.write = data => { if (data.requests[0]?.settled?.resume?.state === 'pending') fail = true; write(data); };
  const host = await fakeBrowserHost({ store });
  try {
    const { lease } = await held(host); host.fixture.authenticated('ada', true);
    await assert.rejects(host.done(lease), e => e instanceof Error && !e.message.includes('synthetic-secret'));
    assert.equal(host.fixture.dispatches.length, 0); assert.equal(host.state('ada').phase, 'blocked');
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('forget exact recorded origins only; all and parked refuse; durable state has no live frames', async () => {
  const host = await fakeBrowserHost();
  try {
    const { r, lease } = await held(host);
    await assert.rejects(host.forget('ada', r.site, { grant: 'control' }), refused('already-open'));
    host.fixture.authenticated('ada', true); await host.done(lease);
    await assert.rejects(host.forget('ada', 'all', { grant: 'control' }), refused('unsupported'));
    await host.forget('ada', r.site, { grant: 'control' });
    assert.ok(host.fixture.calls.includes('ada:clear:1'));
    assert.equal((await raise(host)).firstTime, true);
  } finally { await host.close(); }
});

test('corrupt stores and secret-bearing URLs fail closed with generic errors', async () => {
  const store = memorySignInStore();
  assert.throws(() => store.write({ ...emptySignIns(), v: 2 } as never), /browser state unavailable/);
  const host = await fakeBrowserHost({ store });
  try {
    await assert.rejects(host.raise({ member: 'ada', sessionKey: 's', checkUrl: 'http://127.0.0.1:2820/?password=synthetic-secret', reasons: ['agent-asked'] }), /browser state unavailable/);
    assert.equal(host.signIns().length, 0);
  } finally { await host.close(); }
});

for (const marker of ['pending', 'accepted', 'submitted'] as const) test(`restart resume ${marker} without durable submission proof never redispatches`, async () => {
  const store = memorySignInStore(); const host = await fakeBrowserHost({ store });
  const { lease } = await held(host); host.fixture.authenticated('ada', true); await host.done(lease); await host.close();
  const data = store.read(); data.requests[0].settled!.resume!.state = marker; store.write(data);
  const restored = await fakeBrowserHost({ store });
  try { assert.equal(restored.signIns()[0].settled?.resume?.state, 'indeterminate'); assert.equal(restored.fixture.dispatches.length, 0); }
  finally { await restored.close(); }
});

test('positive verifier checks every condition and final exact origin', async () => {
  const origin = 'http://127.0.0.1:2820'; const verifier = { origin, url: `${origin}/account`, status: 200, selector: '#account' };
  for (const [url, status, exists] of [[`${origin}/account`, 401, true], ['http://127.0.0.1:2821/account', 200, true], [`${origin}/account`, 200, false]] as const) {
    const result = await verifySignIn({ probe: async (_u, verify) => await verify({ url, status, exists: async () => exists }) ? 'ok' : 'fail' }, origin, [verifier], 100);
    assert.deepEqual(result, { state: 'entered-unverified', reason: 'still-signed-out' });
  }
});

test('revocation racing host verification prevents resume and returns only a fresh fenced request', async () => {
  const host = await fakeBrowserHost();
  try {
    const { r, lease } = await held(host); const wait = deferred();
    host.fixture.probe('ada', async () => { await wait.promise; return 'ok'; });
    const done = host.done(lease); await turn();
    const revoked = host.revokeGrant('control'); wait.resolve();
    await assert.rejects(done, refused('stale')); await revoked;
    assert.equal(host.signIns()[0].state, 'waiting'); assert.equal(host.signIns()[0].gen, r.gen + 1);
    assert.equal(host.fixture.dispatches.length, 0); assert.equal(host.fixture.privateOpen('ada'), false); assert.equal(host.fixture.fenced('ada'), true);
  } finally { await host.close(); }
});

test('directory fsync ambiguity blocks submission; restarted pending marker becomes indeterminate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h2b-')); let fail = false; let count = 0;
  const { fsyncSync } = await import('node:fs');
  const store = fileSignInStore(dir, { sync: fd => { count++; if (fail && count % 2 === 0) throw new Error('synthetic-secret'); fsyncSync(fd); } });
  const write = store.write; store.write = data => { if (data.requests[0]?.settled?.resume?.state === 'pending') fail = true; write(data); };
  const host = await fakeBrowserHost({ store });
  try {
    const { lease } = await held(host); host.fixture.authenticated('ada', true);
    await assert.rejects(host.done(lease)); assert.equal(host.fixture.dispatches.length, 0); await host.close();
    const restored = await fakeBrowserHost({ store: fileSignInStore(dir) });
    try { assert.equal(restored.signIns()[0].settled?.resume?.state, 'indeterminate'); assert.equal(restored.fixture.dispatches.length, 0); }
    finally { await restored.close(); }
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('broker recovery is capped at three attempts without model submission or unsafe reuse', async () => {
  const fixture = await fakeBrowserHost(); const broker = fixture.fixture.broker('ada'); let attempts = 0;
  const host = await createBrowserHost({ brokers: new Map([['ada', broker]]), store: memorySignInStore(),
    options: { executablePath: '/synthetic/chromium', members: ['ada'], recovery: { attempts: 3, backoffMs: [0, 0, 0] } },
    authorize: () => true, park: async () => {}, resume: async () => assert.fail('no recovery dispatch'), siteOf: () => '127.0.0.1',
    restart: async () => { attempts++; return undefined; } });
  try { await host.browserGone('ada'); assert.equal(attempts, 3); assert.equal(host.state('ada').why, 'recovery-exhausted'); }
  finally { await host.close(); await fixture.close(); }
});

test('recovery closes the old owned endpoint before replacing it', async () => {
  const fixture = await fakeBrowserHost(); const replacement = await fakeBrowserHost();
  const broker = fixture.fixture.broker('ada'); let closed = false;
  const old = { ...broker, close: async () => { closed = true; await broker.close(); } };
  const host = await createBrowserHost({ brokers: new Map([['ada', old]]), store: memorySignInStore(),
    options: { executablePath: '/synthetic/chromium', members: ['ada'], recovery: { attempts: 1, backoffMs: [0] } },
    authorize: () => true, park: async () => {}, resume: async () => assert.fail('no recovery dispatch'), siteOf: () => '127.0.0.1',
    restart: async () => { assert.equal(closed, true); return replacement.fixture.broker('ada'); } });
  try { await host.browserGone('ada'); assert.equal(closed, true); assert.equal(host.state('ada').why, 'handoff-unprotected'); }
  finally { await host.close(); await fixture.close(); await replacement.close(); }
});

test('member names colliding with Object.prototype are ordinary isolated members', async () => {
  const host = await fakeBrowserHost({ members: ['constructor'] });
  try { assert.equal((await raise(host, 'constructor')).firstTime, true); }
  finally { await host.close(); }
});

function taggedBroker(broker: HostBroker, seq: number): HostBroker {
  return { ...broker, attachViewer(o) {
    const viewer = broker.attachViewer(o);
    return { ...viewer, frames: { async *[Symbol.asyncIterator]() {
      for await (const frame of viewer.frames) yield { ...frame, seq };
    } } };
  } };
}
function dynamicHost(brokers: Map<string, HostBroker>, restart?: BrowserHostServices['restart']) {
  return createBrowserHost({ brokers, store: memorySignInStore(), options: { executablePath: '/synthetic/chromium', members: 'all', recovery: { attempts: 1, backoffMs: [0] } },
    authorize: () => true, park: async () => {}, resume: async () => assert.fail('production cannot dispatch'), siteOf: origin => new URL(origin).hostname, restart });
}

test('later owned member attachment updates the canonical state/thumb/live registry, never enables handoff', async () => {
  const late = await fakeBrowserHost({ members: ['bob'] }); const brokers = new Map<string, HostBroker>();
  const host = await dynamicHost(brokers); const next = taggedBroker(late.fixture.broker('bob'), 901);
  try {
    brokers.set('bob', next); assert.equal(host.state('bob').phase, 'off');
    await host.attachBroker('bob', next);
    assert.equal(host.state('bob').why, 'handoff-unprotected');
    const thumb = await host.thumbnail({ kind: 'browser', member: 'bob' }, { grant: 'view' });
    assert.equal(thumb.state, 'ok'); if (thumb.state === 'ok') assert.equal(thumb.frame.seq, 901);
    const frames: number[] = [];
    const stream = host.live({ kind: 'browser', member: 'bob' }, { grant: 'view' }, { state() {}, frame: f => frames.push(f.seq) });
    await turn(); assert.deepEqual(frames, [901]); stream.close();
    await assert.rejects(host.raise({ member: 'bob', sessionKey: 's', checkUrl: 'http://127.0.0.1:2820', reasons: ['agent-asked'] }), HandoffUnprotected);
  } finally { await host.close(); await late.close(); }
});

test('owned replacement invalidates synchronously and awaits private destruction before settlement/publication', async () => {
  const host = await fakeBrowserHost({ options: { members: 'all' } }); const replacement = await fakeBrowserHost();
  try {
    const { r, lease } = await held(host); const old = host.fixture.broker('ada'); const wait = deferred();
    const states: LiveViewState[] = [];
    const stream = host.live({ kind: 'browser', member: 'ada' }, { grant: 'control', lease }, { state: s => states.push(s), frame() {} });
    await turn(); host.fixture.closePrivate('ada', () => wait.promise);
    const attach = host.attachBroker('ada', replacement.fixture.broker('ada'), old);
    assert.equal(states.at(-1)?.phase, 'ended'); assert.throws(() => stream.input({ kind: 'key', type: 'down', key: 'x' }), refused('stale'));
    assert.throws(() => host.confirmOrigin(lease, r.origin), refused('stale'));
    await assert.rejects(host.takeover(r.id, r.gen, { grant: 'other', confirmSite: r.site }), refused('held-by-other'));
    await turn(); assert.equal(host.fixture.privateOpen('ada'), true); assert.equal(host.signIns()[0].state, 'held'); assert.equal(host.signIns()[0].gen, r.gen);
    assert.equal(host.state('ada').why, 'engine-detached');
    wait.resolve(); await attach;
    assert.equal(host.fixture.privateOpen('ada'), false); assert.equal(host.signIns()[0].settled?.reason, 'browser-gone');
    assert.equal(host.fixture.dispatches.length, 0);
  } finally { await host.close(); await replacement.close(); }
});

test('failed old private close refuses replacement, fresh generation, and candidate endpoint publication', async () => {
  const host = await fakeBrowserHost(); const replacement = await fakeBrowserHost(); let candidateClosed = false;
  try {
    const { r } = await held(host); const next = replacement.fixture.broker('ada');
    host.fixture.closePrivate('ada', async () => { throw new Error('synthetic failure'); });
    await assert.rejects(host.attachBroker('ada', { ...next, close: async () => { candidateClosed = true; await next.close(); } }, host.fixture.broker('ada')), refused('unsupported'));
    assert.equal(candidateClosed, true); assert.equal(host.signIns()[0].gen, r.gen); assert.equal(host.signIns()[0].settled?.reason, 'browser-gone');
    assert.equal(host.fixture.privateOpen('ada'), true); assert.equal(host.fixture.fenced('ada'), true);
    assert.equal(host.state('ada').why, 'recovery-exhausted');
    assert.equal((await host.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'view' })).state, 'off');
  } finally { await host.close(); await replacement.close(); }
});

for (const state of ['waiting', 'parked'] as const) test(`replacement preserves durable ${state}, bumps generation only after close, keeps incoming endpoint fenced for config ack`, async () => {
  const store = memorySignInStore(); const host = await fakeBrowserHost({ store }); const replacement = await fakeBrowserHost();
  try {
    const r = await raise(host); if (state === 'parked') await host.notNow(r.id, r.gen, { grant: 'control' });
    await host.attachBroker('ada', replacement.fixture.broker('ada'), host.fixture.broker('ada'));
    const next = host.signIns()[0]; assert.equal(next.state, state); assert.equal(next.gen, r.gen + 1);
    assert.equal(store.read().requests[0].gen, next.gen); assert.equal(replacement.fixture.fenced('ada'), true);
    assert.equal(host.fixture.dispatches.length, 0);
  } finally { await host.close(); await replacement.close(); }
});

test('exact-previous and delayed old-exit identity guards refuse stale broker replacement', async () => {
  const oldFixture = await fakeBrowserHost(); const newFixture = await fakeBrowserHost(); const staleFixture = await fakeBrowserHost();
  const old = oldFixture.fixture.broker('ada'); const next = taggedBroker(newFixture.fixture.broker('ada'), 902);
  const host = await dynamicHost(new Map([['ada', old]]));
  try {
    await assert.rejects(host.attachBroker('ada', next), refused('stale'));
    await host.attachBroker('ada', next, old);
    await assert.rejects(host.attachBroker('ada', staleFixture.fixture.broker('ada'), old), refused('stale'));
    await host.browserGone('ada', old);
    assert.equal(host.state('ada').why, 'handoff-unprotected');
    const thumb = await host.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'view' });
    assert.equal(thumb.state, 'ok'); if (thumb.state === 'ok') assert.equal(thumb.frame.seq, 902);
  } finally { await host.close(); await oldFixture.close(); await newFixture.close(); await staleFixture.close(); }
});

test('an outstanding recovery callback cannot overwrite a later accepted owned attachment', async () => {
  const oldFixture = await fakeBrowserHost(); const chosen = await fakeBrowserHost(); const stale = await fakeBrowserHost();
  const old = oldFixture.fixture.broker('ada'); const start = deferred(); const release = deferred(); let staleClosed = false;
  const late = stale.fixture.broker('ada');
  const host = await dynamicHost(new Map([['ada', old]]), async () => { start.resolve(); await release.promise; return { ...late, close: async () => { staleClosed = true; await late.close(); } }; });
  try {
    const recovering = host.browserGone('ada', old); await start.promise;
    await host.attachBroker('ada', taggedBroker(chosen.fixture.broker('ada'), 903), old);
    release.resolve(); await recovering;
    assert.equal(staleClosed, true); assert.equal(host.state('ada').why, 'handoff-unprotected');
    const thumb = await host.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'view' });
    assert.equal(thumb.state, 'ok'); if (thumb.state === 'ok') assert.equal(thumb.frame.seq, 903);
  } finally { release.resolve(); await host.close(); await oldFixture.close(); await chosen.close(); await stale.close(); }
});

test('replacement races verification without dispatching the old request', async () => {
  const host = await fakeBrowserHost(); const replacement = await fakeBrowserHost();
  try {
    const { lease } = await held(host); const wait = deferred(); host.fixture.probe('ada', async () => { await wait.promise; return 'ok'; });
    const done = host.done(lease); await turn();
    const attach = host.attachBroker('ada', replacement.fixture.broker('ada'), host.fixture.broker('ada'));
    wait.resolve(); await assert.rejects(done, refused('stale')); await attach;
    assert.equal(host.signIns()[0].settled?.reason, 'browser-gone'); assert.equal(host.fixture.dispatches.length, 0);
  } finally { await host.close(); await replacement.close(); }
});

test('replacement races private-tab creation without returning a stale controller', async () => {
  const host = await fakeBrowserHost(); const replacement = await fakeBrowserHost();
  try {
    const r = await raise(host); const old = host.fixture.broker('ada'); const original = old.openPrivate; const wait = deferred();
    old.openPrivate = async url => { await wait.promise; return original(url); };
    const takeover = host.takeover(r.id, r.gen, { grant: 'control', confirmSite: r.site }); await turn();
    const attach = host.attachBroker('ada', replacement.fixture.broker('ada'), old);
    wait.resolve(); await assert.rejects(takeover, refused('stale')); await attach;
    assert.equal(host.signIns()[0].state, 'waiting'); assert.equal(host.signIns()[0].gen, r.gen + 1);
    assert.equal(host.fixture.privateOpen('ada'), false); assert.equal(replacement.fixture.fenced('ada'), true);
  } finally { await host.close(); await replacement.close(); }
});

test('read-only owned binding snapshots hide pending replacements and reject stale config acknowledgements', async () => {
  const oldFixture = await fakeBrowserHost(); const replacement = await fakeBrowserHost(); const old = oldFixture.fixture.broker('ada');
  const host = await dynamicHost(new Map([['ada', old]]));
  try {
    const before = host.brokerBinding('ada')!; assert.equal(before.broker, old); assert.equal(Object.isFrozen(before), true); assert.equal(Object.isFrozen(before.endpoint), true);
    const wait = deferred(); oldFixture.fixture.closePrivate('ada', () => wait.promise);
    const next = replacement.fixture.broker('ada'); const attaching = host.attachBroker('ada', next, old);
    assert.equal(host.brokerBinding('ada'), undefined); wait.resolve(); await attaching;
    const after = host.brokerBinding('ada')!; assert.equal(after.broker, next); assert.ok(after.generation > before.generation);
    // Same URL is not identity proof; a late config ack must compare both owned broker and generation.
    assert.equal(after.endpoint.cdpUrl, before.endpoint.cdpUrl);
    const staleAck = before.broker === after.broker && before.generation === after.generation;
    assert.equal(staleAck, false); assert.equal(replacement.fixture.fenced('ada'), true);
  } finally { await host.close(); await oldFixture.close(); await replacement.close(); }
});

test('endpoint generation is stable across private lease epochs, recovery adopts only a fenced canonical binding', async () => {
  const fixture = await fakeBrowserHost();
  try {
    const before = fixture.brokerBinding('ada')!; const { lease } = await held(fixture);
    assert.equal(fixture.brokerBinding('ada')!.generation, before.generation);
    await fixture.cancel(lease.requestId, lease.gen, { grant: 'control' });
    assert.equal(fixture.brokerBinding('ada')!.generation, before.generation);
  } finally { await fixture.close(); }
  const old = await fakeBrowserHost(); const replacement = await fakeBrowserHost();
  const host = await dynamicHost(new Map([['ada', old.fixture.broker('ada')]]), async () => replacement.fixture.broker('ada'));
  try {
    const before = host.brokerBinding('ada')!; await host.browserGone('ada', before.broker);
    const after = host.brokerBinding('ada')!; assert.equal(after.broker, replacement.fixture.broker('ada')); assert.ok(after.generation > before.generation);
    assert.equal(replacement.fixture.fenced('ada'), true);
  } finally { await host.close(); await old.close(); await replacement.close(); }
});

test('host requests the actual pushed typed 320px viewer hint and forwards live width without fabricating a frame', async () => {
  const fixture = await fakeBrowserHost(); const broker = fixture.fixture.broker('ada'); const widths: (number | undefined)[] = [];
  const host = await dynamicHost(new Map([['ada', { ...broker, attachViewer(o) { widths.push(o.maxWidth); return broker.attachViewer(o); } }]]));
  try {
    assert.equal((await host.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'view' })).state, 'ok');
    const stream = host.live({ kind: 'browser', member: 'ada' }, { grant: 'view', maxWidth: 256 }, { state() {}, frame() {} });
    await turn(); stream.close(); assert.deepEqual(widths, [320, 256]);
  } finally { await host.close(); await fixture.close(); }
  const over = await fakeBrowserHost(); const source = over.fixture.broker('ada');
  const oversized = await dynamicHost(new Map([['ada', { ...source, attachViewer(o) {
    assert.equal(o.maxWidth, 320); const viewer = source.attachViewer(o);
    return { ...viewer, frames: { async *[Symbol.asyncIterator]() { for await (const frame of viewer.frames) yield { ...frame, w: 1280 }; } } };
  } }]]));
  try { assert.equal((await oversized.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'view' })).state, 'unsupported'); }
  finally { await oversized.close(); await over.close(); }
});

test('failed viewer attachment remains typed off/failed and does not extend a controller claim window', async () => {
  const host = await fakeBrowserHost({ options: { claimMs: 10 } });
  try {
    const { lease } = await held(host); const broker = host.fixture.broker('ada');
    broker.attachViewer = () => { throw new Error('synthetic endpoint failure'); };
    const states: LiveViewState[] = [];
    host.live({ kind: 'browser', member: 'ada' }, { grant: 'control', lease }, { state: s => states.push(s), frame() {} });
    assert.equal(states.at(-1)?.phase, 'failed'); await host.fixture.advance(11);
    assert.equal(host.signIns()[0].state, 'waiting');
    await host.cancel(host.signIns()[0].id, host.signIns()[0].gen, { grant: 'control' });
    assert.equal((await host.thumbnail({ kind: 'browser', member: 'ada' }, { grant: 'view' })).state, 'off');
  } finally { await host.close(); }
});

test('state-ping publication reads the accepted canonical binding synchronously, still fenced', async () => {
  const fixture = await fakeBrowserHost(); const snapshots: unknown[] = [];
  let host: Awaited<ReturnType<typeof createBrowserHost>> | undefined;
  host = await createBrowserHost({ brokers: new Map(), store: memorySignInStore(), options: { executablePath: '/synthetic/chromium', members: 'all' },
    authorize: () => true, park: async () => {}, resume: async () => assert.fail('no production dispatch'), siteOf: origin => new URL(origin).hostname,
    ping: (member, kind) => { if (kind === 'state') snapshots.push(host?.brokerBinding(member)); } });
  try {
    const broker = fixture.fixture.broker('ada'); await host.attachBroker('ada', broker);
    assert.equal(snapshots.length, 1); assert.equal((snapshots[0] as { broker: HostBroker }).broker, broker);
    assert.equal(fixture.fixture.fenced('ada'), true);
  } finally { await host.close(); await fixture.close(); }
});

test('a state-ping reentrant replacement retains its own pending-close reservation', async () => {
  const first = await fakeBrowserHost(); const second = await fakeBrowserHost(); const third = await fakeBrowserHost();
  const wait = deferred(); const firstBroker = first.fixture.broker('ada'); first.fixture.closePrivate('ada', () => wait.promise);
  let host: Awaited<ReturnType<typeof createBrowserHost>> | undefined; let reentered: Promise<void> | undefined;
  host = await createBrowserHost({ brokers: new Map(), store: memorySignInStore(), options: { executablePath: '/synthetic/chromium', members: 'all' },
    authorize: () => true, park: async () => {}, resume: async () => assert.fail('no production dispatch'), siteOf: origin => new URL(origin).hostname,
    ping: (member, kind) => { if (kind === 'state' && host?.brokerBinding(member)?.broker === firstBroker && !reentered) reentered = host.attachBroker(member, second.fixture.broker(member), firstBroker); } });
  try {
    await host.attachBroker('ada', firstBroker); await turn();
    assert.equal(host.brokerBinding('ada'), undefined);
    await assert.rejects(host.attachBroker('ada', third.fixture.broker('ada'), firstBroker), refused('held-by-other'));
    wait.resolve(); await reentered; assert.equal(host.brokerBinding('ada')?.broker, second.fixture.broker('ada'));
  } finally { wait.resolve(); await host.close(); await first.close(); await second.close(); await third.close(); }
});

test('fixture authorization and pings pass through actual grant ids without remapping', async () => {
  const pings: { member: string; kind: string }[] = [];
  const host = await fakeBrowserHost({ authorize: (grant, member, control) => member === 'ada' && (grant === 'random-grant-a' || grant === 'random-grant-b' || (!control && grant === 'random-view')),
    ping: (member, kind) => pings.push({ member, kind }) });
  try {
    const r = await raise(host);
    const lease = await host.takeover(r.id, r.gen, { grant: 'random-grant-a', confirmSite: r.site });
    assert.ok(pings.some(p => p.member === 'ada' && p.kind === 'signin'));
    await host.revokeGrant('random-grant-a');
    assert.throws(() => host.confirmOrigin(lease, r.origin), refused('stale'));
    const next = host.signIns()[0];
    await host.takeover(next.id, next.gen, { grant: 'random-grant-b', confirmSite: next.site });
    assert.equal(host.signIns()[0].state, 'held');
  } finally { await host.close(); }
});
