# Relay provisioning-token enrollment through the hosted recipe

A signed-in phone mints a short-lived, single-use provisioning token; a new computer dials out to the hosted relay
with it and becomes paired with no QR: the relay binds the host to the minting account and the phone's link key,
the computer's app grants exactly that key through link's own durable grants, and the phone reaches it through the
relay over sealed Noise frames the relay cannot read.

## Sub-features

- `dial-out-enroll`: the built `packages/relay/hosted/server.mjs` serves `/health` and the relay routes; a computer's
  `RelayClient({ enrol: token })` comes `online` and `client.provision` carries the binding.
- `no-qr-pairing`: `claimProvision(host, client.provision)` grants the bound phone key, and the phone's `DeviceLink`
  over `linkUrl(relay, hostId)` goes `online` and gets an answer, with no offer, code or approval tap anywhere.
- `account-bound`: `ownerClient.hosts({ account })` shows the new host to the minting account and hides it from others.
- `misuse-refused`: an expired token, a reused token, a token withdrawn with `revokeEnrolment`, and a wrong-account
  key at the same relay address are all refused, and grant nothing.
- `nothing-secret-kept`: the relay state holds only the claim hash; the token claim appears nowhere in state or logs.

## How to get to it (user POV)

- The phone app mints the token (`ownerClient.enrolment({ provision: { account, deviceKey } })`) and shows it once
  for the new computer (typed in, or injected into the cloud machine's setup).
- The computer dials out (`RelayClient(host, { url, enrol: token })`); its app runs
  `claimProvision(host, client.provision)` when `online`.
- The phone finds its computer under its account and connects; the relay only routed sealed frames.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/pair` and `@byokit/relay`.

- **Write the consumer.** `"$scratch_dir/verify-relay-provision-enroll.mjs"` writes a loopback hosted config and
  owner-token file under `$scratch_dir`, spawns the recipe server (`node packages/relay/hosted/server.mjs <config>`,
  cwd in the worktree so `@byokit/relay` resolves to the built workspace), and waits for `GET /health` to answer
  `200 { ok: true }`. It mints a provisioning token (logging only its length), dials a computer out with it, claims
  the binding, then connects the bound phone key through the relay and prints the request answer. Then the misuse
  legs: an expired token (short `ttlMs`, then a wait), the same token on a second computer, a withdrawn token, and a
  stranger key on the same relay address; each prints its refusal. It closes the phone, both computers, the recipe
  server and its scratch files before exit.
- **Run and capture.** `feature=relay-provision-enroll; entry=@byokit/relay; drive=(node "$scratch_dir/verify-relay-provision-enroll.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **Paired with no QR, misuse refused.** `phone: online`, an answer, `hosts(umer): 1`, `hosts(someone-else): 0`,
  and `expired: refused`, `reused: refused`, `withdrawn: refused`, `stranger: removed`, each with no grant added.
- **The misuse legs are the error cases**: they show the real `refused`/`removed` statuses and the `400` for a bad
  binding, never the token itself; run the skill's `leak_check` on the evidence afterwards.

## Gotchas

- Import only the public entries; never `packages/relay/src`.
- The recipe server is the code under test: spawn that file, not an inline relay.
- The token is a credential for the drive: log its length only, and run `leak_check` before finishing.
- Close everything the consumer started (phone link, both relay clients, both hosts, recipe server) before exit.
