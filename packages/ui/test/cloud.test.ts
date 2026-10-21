// Your cloud computers as a person sees them: the cloud kit's own provider on its loopback bench, read into the
// view — the list, what each machine is doing, its newest copy, what it costs, the search, the pick, and what the
// host said when it woke one. The provider, the bench and the kit's own sentences are the real ones; no network,
// key or real machine is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boat } from '../../cloud/src/boat.ts';
import { errorWords } from '../../cloud/src/words.ts';
import type { MachineError } from '../../cloud/src/errors.ts';
import { startFakeSandboxServer } from '../../cloud/src/testing/fake-sandbox-server.ts';
import { cloudSource, cloudStore, cloudView } from '../src/kits.ts';
import WORDS from '../src/words.json' with { type: 'json' };
import { until } from './stub-link.ts';

const PRICE = {
  size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0,
  currency: 'USD' as const, basis: 'incl. IPv4, excl. VAT', source: 'http://boat.test/prices', checked: '2026-09-29',
};

const PLAIN = new RegExp(JSON.parse(readFileSync(new URL('../../../fixtures/conformance/plain-words.json', import.meta.url), 'utf8')).pattern, 'i');
/** The kit's own sentence for a failure, in the app's own words. */
const plainWords = (e: unknown): string => errorWords(e as MachineError, { app: 'Your app', label: 'Test' });

test('your cloud computers: the list, what each is doing, the newest copy, what it costs, the search, the pick and the host\'s answer', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: [PRICE], key: async () => 'test-key' });
    const desk = await provider.create!({ name: 'desk', size: 'small', keepCopies: true, idempotencyKey: 'desk' });
    const lab = await provider.create!({ name: 'lab', size: 'small', keepCopies: false, idempotencyKey: 'lab' });
    await provider.snapshot!(desk, 'today');
    await provider.sleep!(lab);

    // The app remembers the name it gave each machine; the provider's list does not carry one.
    const names = new Map([[desk.id, 'desk'], [lab.id, 'lab']]);
    const source = cloudSource(provider, {
      since: '2026-10-01T00:00:00.000Z',
      monthly: () => ({ perMonth: 5, currency: 'USD' }),
      known: (ref) => ({ id: ref.id, name: names.get(ref.id) ?? ref.name, account: ref.account }),
    });
    const store = cloudStore(source);
    const off = store.subscribe(() => {});
    assert.equal(cloudView(store.get()).headline, 'Loading your cloud computers…', 'the list is being read');
    await until(() => store.get().phase === 'ready');

    const now = Date.now();
    const view = cloudView(store.get(), { now });
    assert.equal(view.headline, '');
    assert.equal(view.rows.length, 2);
    const [first, second] = view.rows;
    assert.deepEqual([first.title, first.stateWords, first.action, first.actionWords], ['desk', 'Awake', 'sleep', 'Put it to sleep']);
    assert.equal(first.copy, 'Copy from just now');
    assert.equal(first.cost, '$0.50 so far this month · about $5.00 a month');
    assert.deepEqual([second.title, second.stateWords, second.action], ['lab', 'Asleep', 'wake']);
    assert.equal(second.copy, undefined, 'a machine with no copy says nothing about one');
    assert.equal(second.cost, '$0.50 so far this month · about $5.00 a month');

    // The search keeps the machines whose name, address or account it matches.
    store.search('lab');
    assert.deepEqual(cloudView(store.get(), { now }).rows.map((r) => r.title), ['lab']);
    store.search('nothing here');
    assert.equal(cloudView(store.get(), { now }).headline, 'No cloud computer matches nothing here.');
    assert.equal(cloudView(store.get(), { now }).empty, true);
    store.search('');

    // The person picks one; the row says so.
    store.select(lab.id);
    const picked = cloudView(store.get(), { now });
    assert.equal(picked.selected, lab.id);
    assert.equal(picked.rows.find((r) => r.id === lab.id)?.selected, true);
    assert.equal(picked.rows.find((r) => r.id === desk.id)?.selected, false);

    // The person asks the host to wake it: the row says so until the host answers.
    store.act(lab.id, 'wake');
    const waking = cloudView(store.get(), { now }).rows.find((r) => r.id === lab.id);
    assert.deepEqual([waking?.stateWords, waking?.pending, waking?.ack], ['Waking it up…', true, undefined]);
    await until(() => store.get().ack !== undefined);
    const answered = cloudView(store.get(), { now }).rows.find((r) => r.id === lab.id);
    assert.deepEqual([answered?.ack, answered?.pending], ["It's awake.", false]);

    // The next read shows the machine awake, and what it costs.
    store.refresh();
    await until(() => store.get().machines.find((m) => m.id === lab.id)?.state === 'on');
    const woken = cloudView(store.get(), { now }).rows.find((r) => r.id === lab.id);
    assert.deepEqual([woken?.stateWords, woken?.action], ['Awake', 'sleep']);
    off();
  } finally {
    await server.close();
  }
});

test('no cloud computers yet, and a host that cannot answer', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: [PRICE], key: async () => 'test-key' });
    const store = cloudStore(cloudSource(provider));
    const off = store.subscribe(() => {});
    await until(() => store.get().phase === 'ready');
    const view = cloudView(store.get());
    assert.equal(view.headline, 'No cloud computers yet.');
    assert.equal(view.empty, true);
    assert.deepEqual(view.rows, []);
    off();
  } finally {
    await server.close();
  }

  // A key the provider does not accept: the host's own words, in the app's plain sentence.
  const denied = await startFakeSandboxServer();
  try {
    const wrong = boat({ baseUrl: denied.url, label: 'Test', prices: [PRICE], key: async () => 'not-the-key' });
    const store = cloudStore(cloudSource(wrong, { words: plainWords }));
    const off = store.subscribe(() => {});
    await until(() => store.get().phase === 'failed');
    const view = cloudView(store.get(), { words: plainWords });
    assert.equal(view.headline, "Can't read your cloud computers right now.");
    assert.equal(view.error, "Test didn't accept your key. Make a new one and try again.");
    assert.deepEqual(view.rows, []);
    off();
  } finally {
    await denied.close();
  }
});

test('every cloud sentence is plain words', () => {
  for (const [key, sentence] of Object.entries(WORDS)) {
    if (!key.startsWith('cloud.')) continue;
    assert.doesNotMatch(sentence.replace(/\{(\w+)\}/g, 'X'), PLAIN, key);
  }
});
