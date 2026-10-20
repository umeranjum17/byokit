# Outbox requestId retry-safe enqueue

A phone (or any caller) that may retry the same outbound enqueue passes a stable
`requestId`. A second enqueue with that id returns the existing entry in any state
and never adds another message, so a reconnect cannot double-send after flush.

## Sub-features

- `dedupe-before-flush`: two enqueues with the same `requestId` leave one entry; flush
  invokes the sender once with the first payload.
- `dedupe-after-restart`: reopen on the same `stateDir`, enqueue the same `requestId`
  again, flush still sends once.
- `dedupe-after-sent`: after a successful flush, enqueue with the same `requestId`
  returns the `sent` entry and a second flush does not call the sender.

## How to get to it (user POV)

- The app calls `outbox.enqueue({ kind, payload, requestId })` for a phone-originated
  send it may retry; a reconnect with the same id does not queue a second message.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/outbox`.

- **Write the consumer.** `"$scratch_dir/verify-outbox-request-id.mjs"` imports `Outbox`
  from `@byokit/outbox`, opens under an exclusive absolute `stateDir` under
  `$scratch_dir`, and uses an in-process fake `sender` that records each job. It
  enqueues twice with `requestId: 'phone-1'`, flushes (expect one send), reopens on the
  same dir, enqueues again with that id, flushes (expect no further send), then after a
  fresh queue sends once and re-enqueues the sent id (expect the `sent` entry back and
  still one send total for that id). Print each leg's entry id, state, list length and
  call count; exit non-zero on mismatch.
- **Run and capture.** `feature=outbox-request-id; entry=@byokit/outbox; drive=(node "$scratch_dir/verify-outbox-request-id.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **Error case:** enqueue with `requestId: ''` must throw `TypeError` naming `requestId`;
  print the real constructor name and message.

## Gotchas

- Import only `@byokit/outbox`; never `packages/outbox/src`.
- `stateDir` must be absolute; close every outbox before reopen or exit.
- Non-visual change: no screenshots. Fake sender only; no network.
