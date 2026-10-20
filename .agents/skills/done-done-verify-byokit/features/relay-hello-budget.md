# Relay hello budget is settable

A host that re-registers during a machine stall gets `4408 too slow`, because the relay allows a fixed 10 s for the
hello. The relay operator can now set a longer hello budget with `helloMs` in `Relay.open` (default 10 s), so a
self-hosted relay beside a machine that stalls under load lets its late hello through.

## Sub-features

- `budget-refused`: with `helloMs: 200`, a host whose hello answers 300 ms after the challenge is closed with
  `4408 too slow`.
- `budget-allowed`: with `helloMs: 600`, the same 300 ms-late hello registers and the relay answers `ready`.
- `default-unchanged`: with `helloMs` omitted, the same 300 ms-late hello still registers (the default is still 10 s),
  and a non-positive `helloMs` fails `Relay.open` with `bad hello budget`.

## How to get to it (user POV)

- A computer dials out to its relay and proves its key; the relay sends a fresh challenge per socket.
- On a loaded machine the answer can arrive late; the relay holds the socket for the hello budget, then closes it.
- The relay operator sets `helloMs` to cover the machine's worst stall; phones see the host come online instead of
  staying offline through the stall.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/relay` and `@byokit/pair`.

- **Write the consumer.** `"$scratch_dir/verify-relay-hello-budget.mjs"` imports `Relay` from `@byokit/relay` and
  `hostId`, `keyPair` from `@byokit/pair` (plus `node:http` and `node:crypto` only). It starts three loopback relays
  (memory store) via `relay.attach(server)`: `{ helloMs: 200 }`, `{ helloMs: 600 }`, and `{}`. It admits one host key
  on each, opens a raw socket to `/relay/v1/host`, waits 300 ms after the challenge, then sends the hello — the DH
  answer recomputed with `node:crypto` (`diffieHellman` of the host secret with the challenge key, HMAC-SHA256 over
  `byokit-relay-host-v1`, nonce, host key, relay key) — printing the close code and reason, or the `ready` id, for
  each leg, then that `Relay.open({ helloMs: 0 })` rejects. It closes every relay and server before exit.
- **Run and capture.** `feature=relay-hello-budget; entry=@byokit/relay; drive=(node "$scratch_dir/verify-relay-hello-budget.mjs")`,
  then run SKILL.md Evidence’s capture block. Exit code `0`.
- **Refused past the budget, allowed inside it.** The `helloMs: 200` leg prints `4408 too slow`; the `helloMs: 600`
  and default legs print `ready` with the host's id; the `helloMs: 0` leg prints `bad hello budget`.
- **The refused leg is the error case**, showing the real close code and reason, never a hang.

## Gotchas

- Import only the public entries; never `packages/relay/src` (the challenge answer is recomputed with `node:crypto`,
  not imported from the kit).
- The stall is a real 300 ms wait after the challenge, not a stubbed timer; the relay under test is the current build.
- The drive must exit `0` and hold no open socket; a still-pending socket would hang the run.
