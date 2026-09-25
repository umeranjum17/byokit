# Changelog

## 0.1.2
- FIX: A relay that is unreachable at connect time no longer crashes the process on Node 22 (a CONNECTING socket's error handler called close(), which re-emitted error recursively). Behaviour now: the socket closes on its own, onStatus reports offline, and the client retries with the existing backoff (1 s doubling to 30 s, jittered); queued requests stay queued; no new error is thrown to the caller. Pure crash removal - no new error path to handle.
