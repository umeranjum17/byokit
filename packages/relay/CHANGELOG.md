# Changelog

## Unreleased

- SECURITY: Removing a phone now reliably stops its push notifications, even if the relay was down or restarting when
  you removed it. Before, `RelayClient.revoke` dropped the device's grant and sent one unsubscribe that was lost if the
  relay stopped, the offline queue overflowed or the host restarted first, so the relay kept the phone's push address.
  Now the unsubscribe is saved first and resent on every connection until the relay confirms it; `revoke()` resolves
  then. Pass a durable `store` to `RelayClient` so a pending unsubscribe survives a restart (the default is memory).
- New in `RelayClient`: `store` and `onRevoked` options and `pending()`; `subscribe` refuses a device still being
  revoked.
- Depends on @byokit/link 0.3.2.

## 0.1.3
- FIX: A failed connect now always reconnects. On Node 22 a refused WebSocket fires only `error` (never `close`), and 0.1.2 scheduled its retry only from `close`, so after the first failed reconnect the host sat at `connecting` forever and never re-registered: 0.1.2 did NOT reconnect on Node 22, despite its note. Contract now, on Node 22.18+, 24 and 26 (all tested, including a real refused socket): the host process stays up, onStatus reports offline, one retry is scheduled per failed socket with the existing backoff (1 s doubling to 30 s, jittered), queued requests stay queued, and the host registers once the relay is listening again.

## 0.1.2
- FIX: A relay that is unreachable at connect time no longer crashes the process on Node 22 (a CONNECTING socket's error handler called close(), which re-emitted error recursively). Behaviour now: the socket closes on its own, onStatus reports offline, and the client retries with the existing backoff (1 s doubling to 30 s, jittered); queued requests stay queued; no new error is thrown to the caller. Pure crash removal - no new error path to handle.
