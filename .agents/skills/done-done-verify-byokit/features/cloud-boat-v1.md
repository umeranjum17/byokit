# Cloud boat adapter (public boat-v1 wire names)

A consumer app rents and drives a Boat cloud computer through the built `@byokit/cloud` `boat()` adapter. This recipe proves the adapter speaks the public boat-v1 API (`docs.boat.dev/openapi/boat-v1.yaml`): nested `sandbox`/`operation`/`snapshot` objects, `user.id`, the `X-Ascii-Confirm-Delete` header, `encoding: 'base64'` file writes, and `plan` over the public `limits.info` fields.

## Sub-features

- `boat-account`: `/me` reads the account id at `user.id`.
- `boat-create-status`: create reads `sandbox.id`; status maps nested `sandbox.state`.
- `boat-exec`: a synchronous command returns `exitCode`/`stdout`/`stderr`; a detached one polls `processId` until `running` is false.
- `boat-write`: a file write is byte-identical and sends `encoding: 'base64'`.
- `boat-remove`: delete sends `X-Ascii-Confirm-Delete: <id>` and waits for `operation.status` `completed` or `blocked`.
- `boat-plan`: `plan` maps `sandboxPlanKey`/`subscriptionTrialEndsAt` (`key`/`why` are absent — no public route/field).
- `boat-existing`: list, consent-gated adoption, collision refusal, and failed-install retry without another rental.
- `boat-error`: a wrong key is a typed `unauthorized` and the key never appears in the message.
- `boat-retry-deadline`: 429 and 5xx are retried at 1 s, 2 s and 4 s, and a transient answer never becomes a hard `provider` failure just because the provider's own answers are slow; one 10 s request deadline caps the waits and ends the retries on an answer that arrives past it. A wait the deadline capped still earns the retry it waited for.
- `boat-tailnet`: keyless `joinTailnet` emits the phone login link then a validated MagicDNS name; status distinguishes joined/needs-login/off and refuses malformed answers. Boat join keys are rejected before exec or file writes.
- `boat-private-bootstrap`: create + install + host + join make zero `/host` calls; `url()` is explicit public exposure, never bootstrap.

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

### Retry and deadline leg

The 429/5xx retries are the one slow path in the adapter, so drive them explicitly: three injected
failures followed by a real answer, and four injected failures with no allowance.

- **Write the consumer.** Append the leg below to `"$scratch_dir/verify-cloud-boat-v1.mjs"` (it reuses the `boat`/`out`/
  `server` above, so run it inside that script's `try`, or as its own script with its own bench).
- **Run and capture.** Same `feature`/`entry`/`drive` as above, then SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `retry-requests: 4` (the first attempt plus the three retries) and `retry-account: "acct-test"` —
  the injected 429, 503 and 500 are absorbed and the fourth answer is the real one — then `exhausted-code: "provider"`
  with `exhausted-requests: 4` for four failures in a row. On a host whose `fetch` adds per-answer latency (Node
  26.7.0 loopback keep-alive does), only the request count and the account id are asserted, never elapsed time: the
  point is that the retry happens, not how long the transport took.

```js
// Retries: three injected failures are absorbed, four are not.
const failing = await startFakeSandboxServer();
try {
  const good = boat({ baseUrl: failing.url, label: 'Boat', prices: [], key: async () => 'test-key' });
  failing.failNext([{ status: 429 }, { status: 503 }, { status: 500 }]);
  const before = failing.requests.length;
  out('retry-account', await good.account());
  out('retry-requests', failing.requests.length - before);
  failing.failNext([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
  const spent = boat({ baseUrl: failing.url, label: 'Boat', prices: [], key: async () => 'test-key' });
  const beforeSpent = failing.requests.length;
  try {
    await spent.account();
    out('exhausted-code', 'NO ERROR (unexpected)');
  } catch (e) {
    out('exhausted-code', e.code);
  }
  out('exhausted-requests', failing.requests.length - beforeSpent);
} finally {
  await failing.close();
}
```

### Existing-computer journey

Run the maintained built-public-entry consumer journey, including the refusal extremes:

```sh
sh scripts/test.sh packages/cloud/test/journey-cloud.test.ts
```

The two existing-computer journeys use fake Boat fetch/loopback only: list all pages, omit
view-only computers, reject malformed replies, verify account/live id/consent before writes,
refuse files/units/symlink parents, fail installation then retry `install` on the saved ref,
and assert no create or resume after selection. The setup screen journey asserts `installing` for
first and saved-computer install failures (including an app callback throwing a non-Error),
`inspecting` for fresh-consent and saved-account guard refusals, then a successful install retry.
A second app adopts successfully on a fresh directory and unit. Capture command/output outside the checkout in `test-own.txt`.
No paid Boat run or real key is authorized or proved.

### Tailnet journey

The maintained journey imports the built public entries, drives the real Boat adapter over the existing
loopback HTTP bench, installs an app to running, relays a synthetic phone approval, and asserts no public hosting
request and no join-key transmission. The remote Tailscale daemon/installer are stand-ins; this proves the SDK
contract, not real Tailscale, TUN selection, provider ingress or phone login.

Live qualification belongs to the authorized Boat lab: root installation, actual absence of `/dev/net/tun`,
userspace daemon, owner phone approval, MagicDNS, and an app served privately through `tailscale serve` (not Funnel).
Probe the disposable app listener locally and on the provider public address from outside; require no response
and no hosted app URL. Keep refusal vs timeout distinct. Delete after each run; follow the supervising shared
spend ledger (USD 10 warning, USD 15 stop; two machines maximum). Do not read ambient keys or stage a join key.
The phone must already be on the same tailnet. Until this is recorded, report live qualification as pending.
The Expo M6 lab now uses a direct encrypted pair socket on loopback plus private Serve, not a public relay URL;
its physical capture remains pending owner sign-in, never qualified by the loopback journey.

## Gotchas

- Import from `@byokit/cloud` and `@byokit/cloud/testing` only; never `packages/cloud/src`.
- The bench is loopback only; this never reaches a real Boat host and spends nothing.
- `key`/`why` are deliberately absent from the adapter (the public API has no current-key route and no sandbox stop-reason field); assert their absence, not a value.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/cloud-boat-v1/` evidence survives.
