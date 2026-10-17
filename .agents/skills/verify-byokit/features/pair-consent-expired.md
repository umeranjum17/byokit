# Pair: a pairing code that runs out while the computer decides says so

When the person at the computer does not answer the prompt in time, the phone says the
code "has run out" (`expired`), not "Your computer said no" (`declined`). The computer's
prompt gets an abort signal when the code runs out, and a yes that arrives after that
grants nothing.

## Sub-features

- `expired-on-timeout`: a `confirm` that never answers, with `pairMs: 200`, refuses the
  device as `expired` (sealed), the `signal` it was given is aborted, and no grant exists.
- `late-yes`: a `confirm` that resolves `true` at 250 ms, after the 200 ms code life, still
  leaves the device refused as `expired` with no grant.

## How to get to it (user POV)

- The phone shows "That pairing code has run out. Show a new one on your computer." when
  the computer's person has not answered within the code's life.

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md), plus the built `@byokit/pair`.

- **Write the consumer.** `"$scratch_dir/verify-pair-consent-expired.mjs"` imports `Host`,
  `keyPair`, `pairWithOffer`, `LINK_WORDS` from `@byokit/pair` and `WebSocketServer` from
  `ws`. It opens a real loopback host (`Host.open`, `pairMs: 200`) served on
  `ws://127.0.0.1:<port>/link`, with a `confirm` that records its `signal` and never
  answers. It pairs a device from the host's offer and expects a rejection with
  `code === 'expired'`, `sealed === true`, message `LINK_WORDS.expired`; then expects
  the recorded signal `aborted === true`, and `host.devices()` and the saved grants empty.
  Second leg: a host whose `confirm` resolves `true` after 250 ms, same expectations
  after waiting 150 ms more. Every leg prints the real code, message and counts; any
  mismatch exits non-zero. Close the host and the server before exit.
- **Run and capture.** `feature=pair-consent-expired; entry=@byokit/pair; drive=(node "$scratch_dir/verify-pair-consent-expired.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **The refusal leg is the error case**: it shows the real typed `expired` and its sentence.

## Gotchas

- Import only the public entries; never `packages/pair/src`.
- The late-yes leg must wait past the 250 ms resolve before checking for grants, or it
  proves nothing.
