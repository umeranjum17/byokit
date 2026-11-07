# NATS bus: supervised server, durable replay, explicit ack

`@byokit/nats`'s `ensureNats({ stateDir })` runs one `nats-server` child on loopback with a token and JetStream on, and
`NatsBus` publishes to a stream and reads it back through a durable reader that acks explicitly.

## Sub-features

- `start-health-stop`: `ensureNats` returns `started: true`, a `nats://127.0.0.1:<port>` url, a token and a `storeDir`
  under the folder passed; `health()` is true; a wrong token is refused; after `stop()` `health()` is false.
- `replay`: messages published before the reader existed arrive; a `nak` comes again with `deliveries: 2`; a repeated
  `msgId` returns `duplicate: true`.
- `resume`: a closed bus and a second `ensureNats` on the same folder adopt the running server (`started: false`, same
  url), and the durable reader gets only what it had not acked.
- `clean-exit` (error case): `bus.close()` returns even when a handler never settles, and the process exits on its own.
- `bad-download` (error case): an archive whose sha256 differs from the pin is refused with `checksum-failed` and leaves
  no binary behind.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), the built `@byokit/nats`, and a nats-server 2.15.2 binary fetched by
`node scripts/fetch-nats.ts <dir>` (the one step that uses the network; the drive itself is loopback only).

- **Write the consumer.** `"$scratch_dir/verify-nats-bus.mjs"` imports `ensureNats`, `NatsBus` from `@byokit/nats`,
  starts the server with `bin` set to the fetched binary and a `stateDir` under `$scratch_dir`, walks the sub-features
  above and prints one line per check. Exit non-zero on any mismatch; a hang is a failure (run it under `timeout 60`).
- **Run and capture.** `feature=nats-bus; entry=@byokit/nats; drive=(timeout 60 node "$scratch_dir/verify-nats-bus.mjs")`,
  then SKILL.md Evidence's capture block. Exit code `0`.

## Gotchas

- Import only public entries; never `packages/nats/src`.
- Non-visual: no screenshots. Stop the server you started (`stop()`); never touch another `nats-server` on the host.
