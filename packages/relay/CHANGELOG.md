# Changelog

## 0.1.3
- FIX: A failed connect now always reconnects. On Node 22 a refused WebSocket fires only `error` (never `close`), and 0.1.2 scheduled its retry only from `close`, so after the first failed reconnect the host sat at `connecting` forever and never re-registered: 0.1.2 did NOT reconnect on Node 22, despite its note. Contract now, on Node 22.18+, 24 and 26 (all tested, including a real refused socket): the host process stays up, onStatus reports offline, one retry is scheduled per failed socket with the existing backoff (1 s doubling to 30 s, jittered), queued requests stay queued, and the host registers once the relay is listening again.

## 0.1.2
- FIX: A relay that is unreachable at connect time no longer crashes the process on Node 22 (a CONNECTING socket's error handler called close(), which re-emitted error recursively). Behaviour now: the socket closes on its own, onStatus reports offline, and the client retries with the existing backoff (1 s doubling to 30 s, jittered); queued requests stay queued; no new error is thrown to the caller. Pure crash removal - no new error path to handle.
