# Changelog

## Unreleased

## 0.1.0 (2026-10-02)

- FEAT: New kit: `bridgeSignaling(url)` speaks a bridge WebSocket's `{id, method, params}` requests and `{event, params}`
  notifications as a typed `Signaling` (concurrent request ids, typed `SignalingError` codes, session events,
  close and listener cleanup); `authorizeBridge(url, session)` opens a fresh socket on every authorization. No
  dependencies; Node 22+, browsers and React Native.
