# Cloud account link (claim and revoke)

A consumer app links the person's Boat account without a pasted key: `claim({ baseUrl, email })` from the built `@byokit/cloud` yields the sign-in link, the code, `waiting`, then `done` with the key, and `revokeClaim({ baseUrl, key })` ends that key when the app forgets the account.

## Sub-features

- `claim-done`: the steps arrive as `open-page`, `type-code`, `waiting`, `done`; the key is in `done` only.
- `claim-spare-revoked`: before `done`, claim revokes the spare `identity_assertion` sent beside the key (the bench's `revoked` set holds it, not the key).
- `claim-revoke`: `revokeClaim` resolves and the key then answers 401 on `GET /me`.
- `claim-revoke-error`: a revoke that fails rejects a typed `MachineError` naming the cause: `unauthorized` (an already-revoked key), `unsupported` (no `revocation_endpoint`), `unreachable`; the key never appears in the message.

## How to get to it (user POV)

- The consumer imports `claim` and `revokeClaim` from `@byokit/cloud` and `startFakeSandboxServer` from `@byokit/cloud/testing`, and runs against the loopback Boat bench's sign-in and RFC 7009 routes. No account, key, sign-in or spend.
- The live form is a lab run against boat.dev with the person signing in on Boat's page: **Live run** below. BYOKit makes no new claim: the 2026-10-18 pass is the claim proof, and a claim needs a person at Boat's page, so a rerun is parked, never asked for. The recipe above never calls Boat.

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

## Live run (boat.dev)

First recorded pass: 2026-10-18, `RESULT PASS`, revoke confirmed (`GET /me` 401 after `revokeClaim`).

- **Rule for every Boat run (captain, 18 Oct).** BYOKit makes no claim itself: a claim needs a person to approve it on Boat's page, so a claim rerun is parked, never asked for; no one is asked to approve one, its link and code are never posted, and the worker never signs in itself. Every other live Boat run (create, install, hosting) uses the fleet's saved Boat key: it never prints, logs, commits or revokes that key, and deletes only the machines it made itself. Never press a billing, trial, checkout or subscription button.
- **A parked claim rerun, when a person is there.** It makes its own fresh claim and revokes that key at the end; this driver makes no machine (its allowlist refuses every sandbox and billing route).
- **Bench check first.** `node .agents/skills/done-done-verify-byokit/capture/cloud-claim-bench.mjs` (loopback only) must end `BENCH PASS` with exit 0: success, assertion exchange, abort before and after the key, expired, refused, the CLI path and Ctrl-C, each with its expected result and no leak, and the CLI handoff kept to `HANDOFF_FILE` (mode 0600).
- **Drive.** From a built checkout, outside `scripts/test.sh` (its egress guard blocks boat.dev): `CLAIM_EMAIL=<the person's Boat email> EVIDENCE_DIR=<private folder outside the repo> HANDOFF_FILE=<private file, mode 0600> CLAIM_DEADLINE_S=1800 node .agents/skills/done-done-verify-byokit/capture/cloud-claim.mjs`. The two `HANDOFF` lines in that file (link, then code) are for the person already at the run; never post them. The deadline aborts the wait; Ctrl-C and SIGTERM abort it too, and the revoke still runs.
- **What proves it.** Exit 0 and `RESULT PASS`; the step lines `step  5 key received: prefix=… len=… fp=… scopes=…`, `check key works: GET /me -> 200`, `check after revoke: GET /me -> 401`, `revoke CONFIRMED`; the evidence log's wire lines name only the metadata GET, identity POST, token POST, revoke POST and `GET /me`; `grep -cE 'boat_[A-Za-z0-9]{6,}|<email local part>@' <log>` and `grep -c REFUSED <log>` both print 0. The 2026-10-18 run's scopes were `box.me box.limits box.write box.billing`.
- **On failure.** A `failed` result reruns once with a fresh claim, then stops. `revoke NOT CONFIRMED` (or a killed process, which skips the revoke) means the key is deleted at once in Boat's dashboard, matched by its creation time, and the run is recorded as "claim pass, revoke manual".

## Gotchas

- Import from `@byokit/cloud` and `@byokit/cloud/testing` only; never `packages/cloud/src`.
- The bench's claimed key is `boat-claimed-key`; start the bench with `key: 'boat-claimed-key'` so `GET /me` accepts it before the revoke.
- The scratch consumer and the bench are loopback only: never boat.dev, a real email sign-in or a real key. Only the live run above calls Boat.
- The claim always carries `box.write` and `box.billing` (claim() requests no scope), so the live key is spend-capable: it stays in memory, every output line passes the leak guard, and it is revoked before the driver exits.
