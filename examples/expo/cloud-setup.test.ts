// Consumer journey for the phone key-paste/claim setup (examples/expo/cloud-setup.ts):
// one identity read at most, the key into the phone's own store, and a plain
// result for every failure. The provider is a loopback fake speaking the real
// Boat /me shape; no network, key or real machine is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MachineError } from '@byokit/cloud';
import type { ClaimStep, MachineRecord, MachineStore } from '@byokit/cloud';
import { setupClaim, setupKey, setupProvider, setupWords } from './cloud-setup.ts';

const KEY = 'boat-test-key-no-spend';
const LABEL = 'Boat';

/** Loopback Boat identity endpoint: status/body per test, counting every read. */
async function meServer(answer: { status: number; body: unknown }) {
  const seen: { auth: string | null }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : null });
      res.writeHead(answer.status, { 'content-type': 'application/json', connection: 'close' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const memStore = (initial: MachineRecord | null = null): MachineStore & { saved: MachineRecord | null } => {
  const store = {
    saved: null as MachineRecord | null,
    load: async () => initial,
    save: async (r: MachineRecord) => { initial = r; store.saved = r; },
  };
  return store;
};

const provider = (baseUrl: string, key = KEY, extra?: { fetch?: typeof fetch; signal?: AbortSignal }) =>
  setupProvider({ label: LABEL, key, baseUrl, ...extra });

test('a pasted key is checked once, then kept in the phone store with the machine ref intact', async () => {
  const fake = await meServer({ status: 200, body: { user: { id: 'u_1' } } });
  try {
    const ref = { provider: 'boat', account: 'u_1', id: 'bx_1', name: 'web', keepCopies: true };
    const store = memStore({ providerKey: 'old-key', ref });
    assert.deepEqual(await setupKey({ provider: provider(fake.baseUrl), store, key: `  ${KEY}  ` }), { ok: true });
    assert.deepEqual(store.saved, { providerKey: KEY, ref });
    assert.equal(fake.seen.length, 1); // the identity check is the only read: no machine, no spend
    assert.equal(fake.seen[0].auth, `Bearer ${KEY}`); // the key travels only in the header
  } finally { await fake.close(); }
});

test('an unknown key is refused in plain words and never stored', async () => {
  const fake = await meServer({ status: 401, body: { error: 'bad key' } });
  try {
    const store = memStore();
    assert.deepEqual(await setupKey({ provider: provider(fake.baseUrl), store, key: KEY }), { ok: false, why: 'unknown-key' });
    assert.equal(store.saved, null);
    const said = setupWords('unknown-key', LABEL);
    assert.equal(said, 'Boat didn\'t accept your key. Make a new one and try again.');
    assert.ok(!said.includes(KEY));
  } finally { await fake.close(); }
});

test('an empty paste checks nothing and spends nothing', async () => {
  const fake = await meServer({ status: 200, body: { user: { id: 'u_1' } } });
  try {
    const store = memStore();
    assert.deepEqual(await setupKey({ provider: provider(fake.baseUrl), store, key: '   ' }), { ok: false, why: 'missing' });
    assert.equal(fake.seen.length, 0);
    assert.equal(setupWords('missing', LABEL), 'Make a key on the Boat site, then paste it here.');
  } finally { await fake.close(); }
});

test('an interrupted connection and a cancelled check save nothing', async () => {
  const down = { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch };
  const store = memStore();
  assert.deepEqual(await setupKey({ provider: provider('http://127.0.0.1:1', KEY, down), store, key: KEY }),
    { ok: false, why: 'unreachable' });
  assert.equal(store.saved, null);
  assert.ok(!setupWords('unreachable', LABEL).includes(KEY));

  const hanging = { fetch: ((...a: [string, RequestInit?]) => new Promise<Response>((_, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    const s = a[1]?.signal as AbortSignal | undefined;
    if (s?.aborted) onAbort(); // like a real fetch: an already-aborted signal rejects at once
    else s?.addEventListener('abort', onAbort, { once: true });
  })) as typeof fetch };
  const abort = new AbortController();
  const waiting = setupKey({ provider: provider('http://127.0.0.1:1', KEY, { ...hanging, signal: abort.signal }), store, key: KEY, signal: abort.signal });
  abort.abort();
  assert.deepEqual(await waiting, { ok: false, why: 'cancelled' });
  assert.equal(store.saved, null);
  assert.equal(setupWords('cancelled', LABEL), 'Cancelled. Nothing was saved.');
});

test('a claim that finishes saves its key; a refused or expired one ends plainly', async () => {
  const shown: string[] = [];
  async function* done(): AsyncGenerator<ClaimStep> {
    yield { step: 'open-page', url: 'https://boat.test/signin' };
    yield { step: 'type-code', url: 'https://boat.test/signin', code: 'ABCD-1234' };
    yield { step: 'waiting' };
    yield { step: 'done', key: 'claimed-key', expires: null, scopes: [] };
  }
  const store = memStore();
  assert.deepEqual(await setupClaim({ steps: done(), store, onStep: (s) => { shown.push(s.step); } }), { ok: true });
  assert.deepEqual(shown, ['open-page', 'type-code', 'waiting']);
  assert.equal(store.saved?.providerKey, 'claimed-key');

  async function* failed(why: 'refused' | 'expired' | 'unreachable'): AsyncGenerator<ClaimStep> {
    yield { step: 'waiting' };
    yield { step: 'failed', why };
  }
  for (const [why, said] of [['refused', 'denied'], ['expired', 'expired'], ['unreachable', 'unreachable']] as const) {
    const missed = memStore();
    assert.deepEqual(await setupClaim({ steps: failed(why), store: missed }), { ok: false, why: said });
    assert.equal(missed.saved, null);
    assert.ok(!setupWords(said, LABEL).includes('claimed-key'));
  }
  assert.equal(setupWords('denied', LABEL), 'The Boat page refused the request. Nothing was saved.');
  assert.equal(setupWords('expired', LABEL), 'The request expired. Start again for a new code. Nothing was saved.');
});

test('a provider-side claim failure keeps its kit error; an unfinished claim saves nothing', async () => {
  async function* broken(): AsyncGenerator<ClaimStep> {
    yield { step: 'open-page', url: 'https://boat.test/signin' };
    yield { step: 'failed', why: 'provider' };
  }
  const error = await setupClaim({ steps: broken(), store: memStore() }).then(() => assert.fail('the claim should fail'), (e: Error) => e);
  assert.ok(error instanceof MachineError && error.code === 'provider');

  async function* empty(): AsyncGenerator<ClaimStep> { /* ends without a terminal step */ }
  const store = memStore();
  assert.deepEqual(await setupClaim({ steps: empty(), store }), { ok: false, why: 'cancelled' });
  assert.equal(store.saved, null);
});
