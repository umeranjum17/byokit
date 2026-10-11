import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as turn } from 'node:timers/promises';
import { browserHostContract, fakeBrowserHost, memorySignInStore, type FakeBrowserHost } from '../../src/testing/browser.ts';
import { createBrowserHost, HandoffUnprotected, SignInRefused } from '../../src/browser/host.ts';
import { emptySignIns, fileSignInStore } from '../../src/browser/store.ts';
import type { LiveViewState } from '../../src/browser.ts';

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


test('corrupt stores and secret-bearing URLs fail closed with generic errors', async () => {
  const store = memorySignInStore();
  assert.throws(() => store.write({ ...emptySignIns(), v: 2 } as never), /browser state unavailable/);
  const host = await fakeBrowserHost({ store });
  try {
    await assert.rejects(host.raise({ member: 'ada', sessionKey: 's', checkUrl: 'http://127.0.0.1:2820/?password=synthetic-secret', reasons: ['agent-asked'] }), /browser state unavailable/);
    assert.equal(host.signIns().length, 0);
  } finally { await host.close(); }
});


test('member names colliding with Object.prototype are ordinary isolated members', async () => {
  const host = await fakeBrowserHost({ members: ['constructor'] });
  try { assert.equal((await raise(host, 'constructor')).firstTime, true); }
  finally { await host.close(); }
});
