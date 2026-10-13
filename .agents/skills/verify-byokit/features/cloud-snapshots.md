# Cloud saved copies, reset and disk space (K3)

A person's cloud computer keeps saved copies of itself. The app lists them, saves one (only the newest few are kept), runs its own auto-save timer, resets the computer from a copy, and shows disk space, all through the built `@byokit/cloud` `machine()` on Boat.

## Sub-features

- `snapshot-save-prune`: `snapshot()` returns a `byokit-<name>-<12 base36>` copy; past `keep` (default 3) the oldest of this machine's copies are deleted, and only after the new copy is listed ready. Another machine's copy is never listed or deleted.
- `snapshot-auto`: `autoSnapshot({ everyMs })` resolves `null` while the newest copy is fresh and saves one when it is due.
- `snapshot-restore`: `restore(id)` brings back the files as they were in the copy, as a new machine (new id, same name) that is on; the old machine is gone. A missing copy rejects `no-snapshot` with `error.noSnapshot` words; `words('snapshot.restore', { date })` says what a reset loses.
- `disk`: `disk()` resolves `{ usedGb, totalGb }` from `df` on the machine.

## How to get to it (user POV)

- The consumer imports `boat`, `machine`, `words` and `errorWords` from `@byokit/cloud` and `startFakeSandboxServer`/`memoryStore` from `@byokit/cloud/testing`, and runs against the loopback Boat bench. No account, key, VM or spend.
- The real-provider form is a lab run with the owner's spend approval and a Boat key file the operator passes in: one smallest machine, a marker file, snapshot, change, restore, marker back, prune with keep 1, then delete every test copy and the machine. Record its log and deleted proof outside the repo.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-cloud-snapshots.mjs"` (below). Import public entries only.
- **Run and capture.** `feature=cloud-snapshots; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-cloud-snapshots.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `marker-after-restore: "saved"`, `new-id: true`, `old-gone: "gone"`, `state: "on"`, `kept` has 3 ids newest first then 1 after `keep: 1`, `other-copy-kept: true`, `auto-fresh: null`, `missing: "no-snapshot"` with its words, and `disk` `{"usedGb":3.1,"totalGb":12}` with its words.

```js
import { boat, machine, words, errorWords } from '@byokit/cloud';
import { memoryStore, startFakeSandboxServer } from '@byokit/cloud/testing';

const out = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const server = await startFakeSandboxServer();
try {
  const provider = boat({ baseUrl: server.url, label: 'Boat', prices: [], key: async () => 'test-key' });
  const m = machine({ provider, store: memoryStore() });
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
  // Another machine whose name starts with this one's; its copy must never be touched.
  const other = await provider.create({ name: 'web-two', size: 'small', keepCopies: true, idempotencyKey: 'other-1' });
  await provider.snapshot(other, 'x');
  const marker = '/home/user/marker.txt';
  const text = (bytes) => new TextDecoder().decode(bytes);
  await provider.write(ref, marker, new TextEncoder().encode('saved'), 0o600);
  const saved = await m.snapshot();
  await provider.write(ref, marker, new TextEncoder().encode('changed'), 0o600);
  out('reset-words', words('snapshot.restore', { date: saved.at.slice(0, 10) }));
  await m.restore(saved.id);
  out('marker-after-restore', text(server.machine.readFile(marker)));
  out('new-id', m.ref.id !== ref.id);
  out('old-gone', await provider.status(ref));
  out('state', await m.state());
  for (let i = 0; i < 3; i++) await m.snapshot();
  out('kept', (await m.snapshots()).map((s) => s.id));
  await m.snapshot({ keep: 1 });
  out('kept-after-keep-1', (await m.snapshots()).map((s) => s.id));
  const names = (await (await fetch(`${server.url}/named-snapshots`, { headers: { Authorization: 'Bearer test-key' } })).json()).snapshots.map((x) => x.name);
  out('other-copy-kept', names.includes('byokit-web-two-x'));
  out('auto-fresh', await m.autoSnapshot({ everyMs: 60_000 }));
  const missing = await m.restore('byokit-web-000000000000').then(() => null, (e) => e);
  out('missing', missing?.code);
  out('missing-words', errorWords(missing, { app: 'Umer', label: 'Boat' }));
  server.machine.script('df', { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 12582912 3250586 9332326 26% /\n', stderr: '', timedOut: false });
  const disk = await m.disk();
  out('disk', disk);
  out('disk-words', words('disk.used', { used: String(disk.usedGb), total: String(disk.totalGb) }));
} finally {
  await server.close();
}
```

## Gotchas

- Import from `@byokit/cloud` and `@byokit/cloud/testing` only; never `packages/cloud/src`.
- The bench has one shared fake machine (`server.machine`): after `restore` it holds the copy's files.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/cloud-snapshots/` evidence survives.
