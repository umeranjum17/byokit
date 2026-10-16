# Relay host lookup is bounded

The device's short-code host lookup, `findHost` (from `@byokit/relay/device`), resolves a code the host showed into
the link address to dial against a live relay. A relay that accepts the request but never answers now rejects with a
typed `RelayLookupError` (`code: 'timeout'`) after a bound — default 8 s (`RELAY_LOOKUP_MS`), settable per call with
`timeoutMs` — and aborts the request, so a dropped relay fails in seconds instead of spinning for the platform's own
~140 s.

## Sub-features

- `bound-applied`: against a relay that never answers, `findHost(url, code, { timeoutMs })` rejects within the bound
  with a `RelayLookupError` whose `code` is `timeout` and whose message names the cause and next step.
- `socket-freed`: the aborted lookup tears its connection down, so the relay has no socket left holding the request.
- `normal-lookup`: the same `findHost` against a live relay still resolves to `wss://…/link/v1/<host id>`.
- `default-bound`: the default is a single-digit number of seconds (`RELAY_LOOKUP_MS`, 8000), matching link's dial
  timeout.

## How to get to it (user POV)

- A host shows a short code from `RelayClient.code()`; a phone types it.
- The phone app calls `findHost(relayUrl, code)`; on a slow or dropped relay it must fail quickly and tell the person
  to check the connection, not spin.
- A `RelayLookupError` `timeout` is what the app branches on to show its own retry copy.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/relay` and `@byokit/pair`.

- **Write the consumer.** `"$scratch_dir/verify-relay-lookup-timeout.mjs"` imports `Relay`, `RelayClient`,
  `RelayLookupError`, `RELAY_LOOKUP_MS` from `@byokit/relay`, `findHost` from `@byokit/relay/device`, and `Host`,
  `keyPair` from `@byokit/pair`. It prints `default bound: <RELAY_LOOKUP_MS>`. It starts a live relay on loopback
  (memory store) via `relay.attach(server)`, registers a host with `RelayClient`, gets its short code and resolves it,
  printing `live lookup: <url>`. Then it starts the same `Relay` class on a server whose request handler never answers
  (`if (dropped) return;`), counts its connections, and calls `findHost(at, 'K7M2QX', { timeoutMs: 300 })`, printing the
  caught error's `name`, `code`, `message` and the elapsed milliseconds, then waits until the connection count is `0`.
  It closes every host, client, relay and server before exit.
- **Run and capture.** `feature=relay-lookup-timeout; entry=@byokit/relay/device; drive=(node "$scratch_dir/verify-relay-lookup-timeout.mjs")`,
  then run SKILL.md Evidence’s capture block. Exit code `0`.
- **Bounded failure, live success.** `live lookup` is the host's `wss://…/link/v1/<id>`; the dropped leg prints
  `RelayLookupError timeout` with a plain sentence, an elapsed time between the bound and a couple of seconds, and
  `connections after timeout: 0`.
- **The dropped leg is the error case**, showing the real typed error and message, never a hang.

## Gotchas

- Import only the public entries; never `packages/relay/src`.
- The dropped server is the same `Relay` class routed through a plain `createServer` handler that returns without
  answering; it is the current code under test, not a stub relay.
- The drive must exit `0` and hold no open socket; a still-pending `findHost` would hang the run, which is the bug.
