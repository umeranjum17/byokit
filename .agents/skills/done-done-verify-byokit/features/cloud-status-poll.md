# Cloud status poll (K1 lifecycle)

A phone (or any app) rents a cloud computer and follows it through create, install, stop, start and delete by polling one read: `status(m, { app, label })` from the built `@byokit/cloud`. It resolves `{ machine, host, words }`, asks the host only while the machine is on, and gives the one plain sentence to show.

## Sub-features

- `status-creating`: right after `create`, Boat's machine is still being set up; `status` reads `creating` with the setting-up sentence and sends no command to the machine.
- `status-host`: once on, `status` carries the host state (`not-installed`, then `running` after `install`) with its sentence.
- `status-stop-start`: after `sleep()` the read is `asleep` with no host; after `wake()` the unit is running again (every wake is a cold boot that starts enabled units).
- `status-gone`: after `remove(ref.id)` the old id reads `gone`, and `status` on the machine rejects the typed `no-machine`.

## How to get to it (user POV)

- The consumer imports `boat`, `machine` and `status` from `@byokit/cloud` and `startFakeSandboxServer`/`memoryStore` from `@byokit/cloud/testing`, and runs against the loopback Boat bench with `slowCreateReads: 2`. No account, key, VM or spend.
- The real-provider form of this journey is a lab run, not this recipe: it needs the owner's spend approval and a Boat key file passed in by the operator, one small machine, a spend and time guard, and delete in `finally` and on a signal. Record its log, timings, cost and deleted-machine proof outside the repo.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-cloud-status-poll.mjs"` (below). Import public entries only.
- **Run and capture.** `feature=cloud-status-poll; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-cloud-status-poll.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `seen` lists, in order, `creating`, `on/not-installed`, `on/running`, `asleep`, `on/running` with their sentences; `exec-while-creating: 0` on each creating read; `gone: "gone"`; and the error leg prints `after-delete: "no-machine"`.

```js
import { boat, machine, status } from '@byokit/cloud';
import { memoryStore, startFakeSandboxServer } from '@byokit/cloud/testing';

const out = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const sha = { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'a'.repeat(64) };
const recipe = { name: 'web', node: { version: '24.15.0', sha256: sha }, install: [['npm', 'ci']],
  run: { argv: ['node', 'server.mjs'], env: {} }, workDir: '/home/user/app' };
const server = await startFakeSandboxServer({ slowCreateReads: 2 });
try {
  const provider = boat({ baseUrl: server.url, label: 'Boat', prices: [], key: async () => 'test-key' });
  const m = machine({ provider, store: memoryStore() });
  const vars = { app: 'Tracker', label: 'Boat' };
  const seen = [];
  const read = async () => { const s = await status(m, vars); seen.push(`${s.machine}/${s.host ?? '-'}: ${s.words}`); return s; };
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
  const commands = () => server.requests.filter((r) => r.path.includes('/commands')).length;
  let s = await read();
  while (s.machine === 'creating') {
    out('exec-while-creating', commands());
    s = await read();
  }
  server.machine.script('npm', { code: 0, stdout: '', stderr: '', timedOut: false });
  await m.install(recipe);
  await read();
  await m.sleep();
  await read();
  await m.wake();
  await read();
  out('seen', seen);
  await m.remove(ref.id);
  out('gone', await provider.status(ref));
  try {
    await status(m, vars);
    out('after-delete', 'NO ERROR (unexpected)');
  } catch (e) {
    out('after-delete', e.code);
  }
} finally {
  await server.close();
}
```

## Gotchas

- Import from `@byokit/cloud` and `@byokit/cloud/testing` only; never `packages/cloud/src`.
- `status` never calls `host()` while the machine is not on; a poll that shows `creating` must not be followed by `install` until it reads `on`.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/cloud-status-poll/` evidence survives.
