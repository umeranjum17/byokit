# Undo an update of the cloud computer (K-UNDO)

A person updates the app's host on their cloud computer; the kit first saves a copy from just before the update. When the new version breaks the host, the app undoes the update: the computer comes back from that copy with the old files and a running host. All through the built `@byokit/cloud` `machine()` on Boat.

## Sub-features

- `update-copy`: on a machine with copies, `update(recipe)` saves a `byokit-<name>-undo<12 base36>` copy first and resolves `{ undo: <the copy> }` with `kind: 'before-update'`; the next update replaces it, so one is kept. `undoPoint()` resolves it.
- `update-undo`: `undoUpdate(recipe)` resets to that copy as `restore` does (a new machine, new id, old one gone): the files from before the update are back, the host runs, and `installed.json` names the new id. The copy stays. `words('update.undo', { date })` says what an undo loses. With no such copy it rejects `no-undo` with `error.noUndo` words.
- `update-refused`: past Boat's free copies with no credit, `update` rejects `balance` with `extra.why: 'copies'` and the `copies.noCredit` words, and nothing ran on the machine.
- `update-no-undo`: `update(recipe, { undo: false })` resolves `{ undo: null }` and saves no copy.

## How to get to it (user POV)

- The consumer imports `boat`, `machine`, `words` and `errorWords` from `@byokit/cloud` and `startFakeSandboxServer`/`memoryStore` from `@byokit/cloud/testing`, and runs against the loopback Boat bench. No account, key, VM or spend.
- The real-provider form is 5.17's S4 (docs/cloud-kit.md): a lab run with the owner's spend approval on one real machine with copies on. Until it passes, undo is not proven on a real Boat computer.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-update-undo.mjs"` (below). Import public entries only.
- **Run and capture.** `feature=update-undo; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-update-undo.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `no-undo-yet: "no-undo"` with its words; `undo-copy` matches `byokit-web-undo…` with `undo-kind: "before-update"` and `before-update-copies: 1` after two updates; `host-broken: "failed"`; after the undo `version: "Umer v1"`, `new-id: true`, `old-gone: "gone"`, `host: "running"`, `installed-id-matches: true`, `undo-point-kept: true`; `refused: "balance"` with `refused-why: "copies"`, its words and `runs-unchanged: true`; `undo-false` is `{"undo":null}` with `copies-unchanged: true`.

```js
import { boat, machine, words, errorWords } from '@byokit/cloud';
import { memoryStore, startFakeSandboxServer } from '@byokit/cloud/testing';

const out = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const text = (bytes) => new TextDecoder().decode(bytes);
const recipe = {
  name: 'web', node: { version: '24.15.0', sha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'a'.repeat(64) } },
  install: [['npm', 'ci']], update: [['npm', 'run', 'migrate']],
  run: { argv: ['node', 'server.mjs'], env: { PORT: '7310' } }, workDir: '/home/user/app',
};
const version = '/home/user/app/version.txt';
const server = await startFakeSandboxServer();
try {
  const provider = boat({ baseUrl: server.url, label: 'Boat', prices: [], key: async () => 'test-key' });
  const m = machine({ provider, store: memoryStore() });
  const old = await m.create({ name: 'web', size: 'small', keepCopies: true });
  await m.install(recipe);
  await provider.write(old, version, new TextEncoder().encode('Umer v1'), 0o600);
  const none = await m.undoUpdate(recipe).then(() => null, (e) => e);
  out('no-undo-yet', none?.code);
  out('no-undo-words', errorWords(none, { app: 'Umer', label: 'Boat' }));
  await m.update(recipe);
  const updated = await m.update(recipe);
  out('undo-copy', updated.undo.id);
  out('undo-kind', updated.undo.kind);
  out('before-update-copies', (await m.snapshots()).filter((c) => c.kind === 'before-update').length);
  out('ready-words', words('update.undoReady'));
  // The new version changes the files and its host crash-loops.
  await provider.write(old, version, new TextEncoder().encode('Umer v2'), 0o600);
  server.machine.units.get('web').show = { LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed', NRestarts: 5 };
  out('host-broken', await m.host());
  const point = await m.undoPoint();
  out('undo-words', words('update.undo', { date: point.at.slice(0, 10) }));
  await m.undoUpdate(recipe);
  out('version', text(server.machine.readFile(version)));
  out('new-id', m.ref.id !== old.id);
  out('old-gone', await provider.status(old));
  out('host', await m.host());
  out('installed-id-matches', JSON.parse(text(server.machine.readFile('/home/user/app/.byokit/installed.json'))).id === m.ref.id);
  out('undo-point-kept', (await m.undoPoint())?.id === point.id);
  const copies = (await m.snapshots()).map((c) => c.id);
  out('undo-false', await m.update(recipe, { undo: false }));
  out('copies-unchanged', JSON.stringify((await m.snapshots()).map((c) => c.id)) === JSON.stringify(copies));
} finally {
  await server.close();
}
// Past the free copies with no credit: the save is refused and nothing runs on the machine.
const paid = await startFakeSandboxServer();
try {
  const provider = boat({ baseUrl: paid.url, label: 'Boat', prices: [], key: async () => 'test-key' });
  const m = machine({ provider, store: memoryStore() });
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
  await m.install(recipe);
  for (let i = 0; i < 10; i++) await provider.snapshot(ref, `free${i}`);
  paid.setBalance(0);
  const runs = paid.machine.runs.length;
  const refused = await m.update(recipe).then(() => null, (e) => e);
  out('refused', refused?.code);
  out('refused-why', refused?.extra.why);
  out('refused-words', errorWords(refused, { app: 'Umer', label: 'Boat' }));
  out('runs-unchanged', paid.machine.runs.length === runs);
} finally {
  await paid.close();
}
```

## Gotchas

- Import from `@byokit/cloud` and `@byokit/cloud/testing` only; never `packages/cloud/src`.
- The bench has one shared fake machine (`server.machine`): a machine made from a copy gets the copy's files and boots, so its enabled units run again.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/update-undo/` evidence survives.
