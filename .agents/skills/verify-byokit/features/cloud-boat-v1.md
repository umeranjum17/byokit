# Cloud boat adapter (public boat-v1 wire names)

A consumer app rents and drives a Boat cloud computer through the built `@byokit/cloud` `boat()` adapter. This recipe proves the adapter speaks the public boat-v1 API (`docs.boat.dev/openapi/boat-v1.yaml`): nested `sandbox`/`operation`/`snapshot` objects, `user.id`, the `X-Ascii-Confirm-Delete` header, `encoding: 'base64'` file writes, and `plan` over the public `limits.info` fields.

## Sub-features

- `boat-account`: `/me` reads the account id at `user.id`.
- `boat-create-status`: create reads `sandbox.id`; status maps nested `sandbox.state`.
- `boat-exec`: a synchronous command returns `exitCode`/`stdout`/`stderr`; a detached one polls `processId` until `running` is false.
- `boat-write`: a file write is byte-identical and sends `encoding: 'base64'`.
- `boat-remove`: delete sends `X-Ascii-Confirm-Delete: <id>` and waits for `operation.status` `completed`.
- `boat-plan`: `plan` maps `sandboxPlanKey`/`subscriptionTrialEndsAt` (`key`/`why` are absent — no public route/field).
- `boat-error`: a wrong key is a typed `unauthorized` and the key never appears in the message.

## How to get to it (user POV)

- The consumer imports `boat` and `machine` from `@byokit/cloud` and `startFakeSandboxServer`/`memoryStore` from `@byokit/cloud/testing`, then runs the machine against the loopback bench. No account, key, VM or spend.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-cloud-boat-v1.mjs"` (below). Import public entries only.
- **Run and capture.** `feature=cloud-boat-v1; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-cloud-boat-v1.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `write-encoding: "base64"`, `write-byte-identical: true`, `delete-header-ok: true` with `x-delete-confirmation` absent, `state-ready: "on"`/`state-archived: "asleep"`, `plan.canStayOn` true, and the error leg prints `wrong-key-code: "unauthorized"` with `wrong-key-leaks: false`.

```js
import { boat, machine } from '@byokit/cloud';
import { memoryStore, startFakeSandboxServer } from '@byokit/cloud/testing';

const out = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const server = await startFakeSandboxServer();
try {
  const provider = boat({ baseUrl: server.url, label: 'Boat', prices: [], key: async () => 'test-key' });
  out('account', await provider.account());
  const m = machine({ provider, store: memoryStore() });
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
  out('created-id', ref.id);
  server.setState(ref.id, 'ready');
  out('state-ready', await provider.status(ref));
  server.setState(ref.id, 'archived');
  out('state-archived', await provider.status(ref));
  server.setState(ref.id, 'ready');
  server.machine.script('echo', { code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
  out('exec', await provider.exec(ref, ['echo', "it's", 'a;b'], { timeoutMs: 5000 }));
  const bytes = new TextEncoder().encode('hello public api');
  await provider.write(ref, '/home/user/app/x.txt', bytes, 0o600);
  out('write-byte-identical', Buffer.from(server.machine.readFile('/home/user/app/x.txt')).toString('utf8') === 'hello public api');
  out('write-encoding', server.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/files')).at(-1).body.encoding);
  out('plan', await provider.plan());
  await provider.remove(ref, ref.id);
  const del = server.requests.find((r) => r.method === 'DELETE' && r.path === `/sandboxes/${ref.id}`);
  out('delete-header-ok', del.headers['x-ascii-confirm-delete'] === ref.id);
  out('delete-header-name', del.headers['x-delete-confirmation'] === undefined);
  const bad = boat({ baseUrl: server.url, label: 'Boat', prices: [], key: async () => 'sk-secret-123' });
  try {
    await bad.account();
    out('wrong-key', 'NO ERROR (unexpected)');
  } catch (e) {
    out('wrong-key-code', e.code);
    out('wrong-key-leaks', e.message.includes('sk-secret-123'));
  }
} finally {
  await server.close();
}
```

## Gotchas

- Import from `@byokit/cloud` and `@byokit/cloud/testing` only; never `packages/cloud/src`.
- The bench is loopback only; this never reaches a real Boat host and spends nothing.
- `key`/`why` are deliberately absent from the adapter (the public API has no current-key route and no sandbox stop-reason field); assert their absence, not a value.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/cloud-boat-v1/` evidence survives.
