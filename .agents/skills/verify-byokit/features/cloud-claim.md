# Cloud account link (claim and revoke)

A consumer app links the person's Boat account without a pasted key: `claim({ baseUrl, email })` from the built `@byokit/cloud` yields the sign-in link, the code, `waiting`, then `done` with the key, and `revokeClaim({ baseUrl, key })` ends that key when the app forgets the account.

## Sub-features

- `claim-done`: the steps arrive as `open-page`, `type-code`, `waiting`, `done`; the key is in `done` only.
- `claim-spare-revoked`: before `done`, claim revokes the spare `identity_assertion` sent beside the key (the bench's `revoked` set holds it, not the key).
- `claim-revoke`: `revokeClaim` resolves and the key then answers 401 on `GET /me`.
- `claim-revoke-error`: a revoke that fails rejects a typed `MachineError` naming the cause: `unauthorized` (an already-revoked key), `unsupported` (no `revocation_endpoint`), `unreachable`; the key never appears in the message.

## How to get to it (user POV)

- The consumer imports `claim` and `revokeClaim` from `@byokit/cloud` and `startFakeSandboxServer` from `@byokit/cloud/testing`, and runs against the loopback Boat bench's sign-in and RFC 7009 routes. No account, key, sign-in or spend.
- The live form is a lab run against boat.dev with the person signing in on Boat's page; it is not this recipe and stays pending until recorded (no Boat call is authorized here).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-cloud-claim.mjs"` (below). Import public entries only.
- **Run and capture.** `feature=cloud-claim; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-cloud-claim.mjs")`, then run SKILL.md Evidence's capture block, then `leak_check boat-claimed-key`. Exit code `0`.
- **What it proves.** `steps: ["open-page","type-code","waiting","done"]`, `spare-revoked: true`, `key-revoked-by-claim: false`, `me-before: 200`, `me-after: 401`, and the error leg prints `again-code: "unauthorized"`, `no-endpoint-code: "unsupported"`, `unreachable-code: "unreachable"` with `leaks: false`.

```js
import { claim, revokeClaim } from '@byokit/cloud';
import { startFakeSandboxServer } from '@byokit/cloud/testing';

const out = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const server = await startFakeSandboxServer({ key: 'boat-claimed-key' });
const code = async (p) => p.then(() => 'NO ERROR (unexpected)', (e) => {
  if (e.message.includes('boat-claimed-key')) out('leaks', true);
  return e.code;
});
try {
  const steps = [];
  let key = '';
  for await (const s of claim({ baseUrl: server.url, email: 'umer@example.com' })) {
    steps.push(s.step);
    if (s.step === 'done') key = s.key;
  }
  out('steps', steps);
  out('spare-revoked', server.revoked.has('assert-test-claimed'));
  out('key-revoked-by-claim', server.revoked.has(key));
  const me = async () => (await fetch(`${server.url}/me`, { headers: { Authorization: `Bearer ${key}` } })).status;
  out('me-before', await me());
  await revokeClaim({ baseUrl: server.url, key });
  out('me-after', await me());
  out('again-code', await code(revokeClaim({ baseUrl: server.url, key })));
  server.failNext([{ status: 200, body: {} }]);
  out('no-endpoint-code', await code(revokeClaim({ baseUrl: server.url, key })));
  out('unreachable-code', await code(revokeClaim({ baseUrl: 'http://127.0.0.1:1/api/v1', key })));
  out('leaks', false);
} finally {
  await server.close();
}
```

The maintained journey is `sh scripts/test.sh packages/cloud/test/claim.test.ts`; it also covers the fail-closed claim (a spare assertion that cannot be revoked ends `failed` with no key) and a revoke 400 kept as `provider` with the provider's error code.

## Gotchas

- Import from `@byokit/cloud` and `@byokit/cloud/testing` only; never `packages/cloud/src`.
- The bench's claimed key is `boat-claimed-key`; start the bench with `key: 'boat-claimed-key'` so `GET /me` accepts it before the revoke.
- Loopback only: never boat.dev, a real email sign-in or a real key.
