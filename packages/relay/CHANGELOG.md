# Changelog

## Unreleased

## 0.4.2 (2026-09-30)

- Dependency update: pins @byokit/link 0.6.0.

## 0.4.1 (2026-09-30)

- Dependency update: pins @byokit/link 0.5.1.

- FIX: (from @byokit/link 0.5.1) Reject an authenticated empty transport frame instead of decoding it as an empty control message.
- Document the relay threat model and review evidence; add seeded push envelope and host-proof fuzz tests.

## 0.4.0 (2026-09-30)

- Add explicit capped open signup on self-hosted relays, with proof of key and atomic registration.
- Add a server notification filter and `contentFreeNotify(title)` preset for fixed-title pushes with hashed ids
  and no body, data or buttons.
- Add trusted host/tenant rate-limit bucket selection, retaining per-IP limits by default, and document
  durable reconnect reconciliation.

## 0.3.1 (2026-09-30)

- FIX: (from @byokit/link 0.5.0) `decodeOffer()` reads legacy compact direct pairing codes with checksum, padding, bounds and expiry validation; new encodings keep the complete current format.
- Dependency update: pins @byokit/link 0.5.0.


## 0.3.0 (2026-09-30)

- Add `ownerClient(url, token)` for listing hosts, creating enrolments and revoking hosts, with injectable fetch
  and typed HTTP errors, and `linkUrl(relay, hostId)` in the device entry for constructing link addresses.

## 0.2.2 (2026-09-30)

- Depends on @byokit/link 0.4.0.

## 0.2.1
- FIX: A half-open host socket no longer looks alive forever. `RelayClient` pings the relay every
  20 s (`pingMs` option) and the relay answers `pong`; after two silent rounds the client closes
  the socket and reconnects through the usual offline+backoff path. A tick that fires late because
  the host's own timers were frozen resets the silence instead of closing, the same guard as
  link's `DeviceLink.ping`.

## 0.2.0 (2026-09-29)

- SECURITY: Removing a phone now reliably stops its push notifications, even if the relay was down or restarting when
  you removed it. Before, `RelayClient.revoke` dropped the device's grant and sent one unsubscribe that was lost if the
  offline queue overflowed or the host stopped or restarted before the relay was back, so the relay kept the phone's
  push address.
  Now the unsubscribe is saved first and resent on every connection until the relay confirms it; `revoke()` resolves
  then. Pass a durable `store` to `RelayClient` so a pending unsubscribe survives a restart (the default is memory).
- New in `RelayClient`: `store` and `onRevoked` options and `pending()`; `subscribe` refuses a device still being
  revoked.
- Depends on @byokit/link 0.3.2.

## 0.1.3
- FIX: A failed connect now always reconnects. On Node 22 a refused WebSocket fires only `error` (never `close`), and 0.1.2 scheduled its retry only from `close`, so after the first failed reconnect the host sat at `connecting` forever and never re-registered: 0.1.2 did NOT reconnect on Node 22, despite its note. Contract now, on Node 22.18+, 24 and 26 (all tested, including a real refused socket): the host process stays up, onStatus reports offline, one retry is scheduled per failed socket with the existing backoff (1 s doubling to 30 s, jittered), queued requests stay queued, and the host registers once the relay is listening again.

## 0.1.2
- FIX: A relay that is unreachable at connect time no longer crashes the process on Node 22 (a CONNECTING socket's error handler called close(), which re-emitted error recursively). Behaviour now: the socket closes on its own, onStatus reports offline, and the client retries with the existing backoff (1 s doubling to 30 s, jittered); queued requests stay queued; no new error is thrown to the caller. Pure crash removal - no new error path to handle.
