# UI cloud machines view

A person opens their app and sees the cloud computers they have: each one's name, what it is doing right now ("Awake", "Asleep", "Waking up…"), how old its newest saved copy is, what it costs, and what the host answered when they asked it to wake one. The list is searchable, one machine can be picked, and every line is a plain sentence a person can read at a glance. The view is headless: an app fills a source from its own cloud provider and draws the rows its own way. No key, account, spend or live provider call is involved.

## Sub-features

- `cloudSource(provider, { since, monthly, known, words })` builds the source from a cloud provider. The cloud kit's own `Provider` fits as it is (its `list`, `status`, `usage`, `snapshots`, `wake` and `sleep` are read structurally, D3), and so does one that lists more machines with their own address, state and newest copy. `since` is where the spend reading starts, `monthly` the month's figure for a machine, `known` the app's own record of a machine (the name it gave it, which its copies are named after) and `words` the host's plain sentence for a failure.
- `cloudStore(source)` keeps the list live: it is read when the first listener arrives and again on `refresh()`, and the answer to an action lands in the row that asked for it. `search(text)`, `select(id)` and `act(id, action)` are what it offers; the newest read wins, so a slow read never overwrites a newer one.
- `cloudView(state, { now, words })` gives the rows to draw. Each row carries its `title`, `state`, `stateWords` (`Awake`, `Asleep`, `Waking up…`, `Setting up`, `Going to sleep`, `Can't tell right now`, `Not working`, `No longer there`, `Its address changed`), its newest `copy` (`Copy from 2 hours ago`), what it `cost` (`$0.50 so far this month · about $5.00 a month`), the `action` the person can take (`wake` for an asleep machine, `sleep` for an awake one) with its `actionWords`, whether it is `pending`, and the host's `ack` for the last action.
- The line above the list says how the read went: `Loading your cloud computers…`, `No cloud computers yet.`, `No cloud computer matches lab.` or `Can't read your cloud computers right now.`, with the host's own words under it (`view.error`). `empty` is true when the list is read and there is nothing in it to show.
- The search keeps the machines whose name, address or account it matches; the pick is kept across refreshes, and only the row that was picked reads as selected.
- `cloudStep(state, action)` is the reducer underneath, and `useCloud(source)` is the React hook over the same store. Every cloud sentence is plain words, checked against the repo's plain-words rule.

## How to get to it (user POV)

An app that rents cloud computers for a person shows them the list: what is running, what is asleep, what a reset would bring back, and what it is costing. This slice adds no screen of its own — an app draws the rows its own way — so on this host the surface is a Node consumer over the built entry, driven against the cloud kit's loopback bench.

## Driving it with node scratch consumers

From the worktree root, after `npm run build` (see the parent skill), a plain consumer reads the built `@byokit/ui/kits` view over the built `@byokit/cloud` provider on the kit's own loopback bench. This is the same journey `packages/ui/test/cloud.test.ts` runs under `scripts/test.sh`:

```js
import { createRequire } from 'node:module';
import { boat, errorWords } from '@byokit/cloud';
import { startFakeSandboxServer } from '@byokit/cloud/testing';
import { cloudSource, cloudStore, cloudView } from '@byokit/ui/kits';

const require = createRequire(import.meta.url);
console.log('ui    ->', require.resolve('@byokit/ui/kits'));   // packages/ui/dist/kits.js
console.log('cloud ->', require.resolve('@byokit/cloud'));     // packages/cloud/dist/index.js

const fail = (message) => { throw new Error(message); };
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) fail('timed out waiting for the cloud list');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const prices = [{ size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0, currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://boat.test/prices', checked: '2026-09-29' }];

const server = await startFakeSandboxServer();
try {
  const provider = boat({ baseUrl: server.url, label: 'Test', prices, key: async () => 'test-key' });
  const desk = await provider.create({ name: 'desk', size: 'small', keepCopies: true, idempotencyKey: 'desk' });
  const lab = await provider.create({ name: 'lab', size: 'small', keepCopies: false, idempotencyKey: 'lab' });
  await provider.snapshot(desk, 'today');
  await provider.sleep(lab);

  // The app remembers the name it gave each machine; the provider's list does not carry one.
  const names = new Map([[desk.id, 'desk'], [lab.id, 'lab']]);
  const store = cloudStore(cloudSource(provider, {
    since: '2026-10-01T00:00:00.000Z',
    monthly: () => ({ perMonth: 5, currency: 'USD' }),
    known: (ref) => ({ id: ref.id, name: names.get(ref.id) ?? ref.name, account: ref.account }),
  }));
  const off = store.subscribe(() => {});
  await until(() => store.get().phase === 'ready');

  const view = cloudView(store.get());
  if (view.rows.length !== 2) fail(`two machines expected, got ${view.rows.length}`);
  const [first, second] = view.rows;
  if (first.title !== 'desk' || first.stateWords !== 'Awake' || first.action !== 'sleep') fail(`desk row: ${JSON.stringify(first)}`);
  if (!first.copy || !first.copy.startsWith('Copy from ')) fail(`desk copy: ${first.copy}`);
  if (first.cost !== '$0.50 so far this month · about $5.00 a month') fail(`desk cost: ${first.cost}`);
  if (second.title !== 'lab' || second.stateWords !== 'Asleep' || second.action !== 'wake') fail(`lab row: ${JSON.stringify(second)}`);
  console.log(view.rows.map((r) => `${r.title} — ${r.stateWords}${r.copy ? ` · ${r.copy}` : ''}${r.cost ? ` · ${r.cost}` : ''}`).join('\n'));

  // The search keeps one machine; the pick marks it.
  store.search('lab');
  if (cloudView(store.get()).rows.length !== 1) fail('search kept the wrong machines');
  store.search('nothing here');
  if (cloudView(store.get()).headline !== 'No cloud computer matches nothing here.') fail('search words');
  store.search('');
  store.select(lab.id);
  if (!cloudView(store.get()).rows.find((r) => r.id === lab.id)?.selected) fail('the pick is not marked');

  // The person asks the host to wake it: the row says so until the host answers.
  store.act(lab.id, 'wake');
  const waking = cloudView(store.get()).rows.find((r) => r.id === lab.id);
  if (waking.stateWords !== 'Waking it up…' || !waking.pending) fail(`waking row: ${JSON.stringify(waking)}`);
  await until(() => store.get().ack !== undefined);
  const answered = cloudView(store.get()).rows.find((r) => r.id === lab.id);
  if (answered.ack !== "It's awake." || answered.pending) fail(`the host's answer: ${JSON.stringify(answered)}`);
  store.refresh();
  await until(() => store.get().machines.find((m) => m.id === lab.id)?.state === 'on');
  if (cloudView(store.get()).rows.find((r) => r.id === lab.id)?.stateWords !== 'Awake') fail('the machine is still asleep');
  off();
} finally { await server.close(); }

// The error case: a key the provider does not accept.
const denied = await startFakeSandboxServer();
try {
  const wrong = boat({ baseUrl: denied.url, label: 'Test', prices, key: async () => 'not-the-key' });
  const plain = (e) => errorWords(e, { app: 'Your app', label: 'Test' });
  const store = cloudStore(cloudSource(wrong, { words: plain }));
  const off = store.subscribe(() => {});
  await until(() => store.get().phase === 'failed');
  const view = cloudView(store.get(), { words: plain });
  if (view.headline !== "Can't read your cloud computers right now.") fail(`failure words: ${view.headline}`);
  if (view.error !== "Test didn't accept your key. Make a new one and try again.") fail(`the host's words: ${view.error}`);
  console.log('failed ->', view.headline, '|', view.error);
  off();
} finally { await denied.close(); }

console.log('DRIVE OK');
```

Run it from a `$scratch_dir` **inside the worktree root** (`scratch_dir=$(mktemp -d ./scratch.verify-byokit.XXXXXX)`) so the bare imports resolve to the workspace; do not import the built files by absolute path. `node consumer.mjs` prints both resolved paths inside `packages/*/dist`, one line per machine (`desk — Awake · Copy from just now · $0.50 so far this month · about $5.00 a month` and `lab — Asleep · $0.50 so far this month · about $5.00 a month`), the failure line and its host words, and `DRIVE OK`. The resolved paths must be inside `packages/*/dist`, never a registry copy. The same run fails when the list, the copy, the cost, the search, the pick, the waking row, the host's answer or the failure words are wrong. Remove the scratch folder when the run ends.

## Gotchas

- This is not a visual change: there is no screen, so there are no narrow/larger-text screenshots — the consumer's exact text output in the drive output is the proof.
- `@byokit/ui/kits` is a portable entry: no Node and no React. The cloud view imports only `./words.json` and the store helper; `test/portable.test.ts` and the entry's own bundle check fail otherwise.
- The view reads only the fields it names, so a credential on a machine object never reaches a row (D3); extra fields are ignored, not copied.
- The type restatement is deliberate: a change to the cloud kit's `Provider` does not flow through automatically. The kit's own provider fits `CloudProvider` as it is, and a provider that lists more machines (a roster of accounts, a machine with its own subdomain, state and newest copy) fits too.
- A machine's name is the name the app gave it: the provider's list does not carry one, and the kit's saved copies are named after it, so the app's own record (`known`) is what the copy lookup and the row title use.
- Every cloud sentence is plain words: the money and the copy's age are slots, so the static copy passes the repo's plain-words rule (`fixtures/conformance/plain-words.json`).
