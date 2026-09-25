# Changelog

## 0.1.2
- FIX: Avoid closing a CONNECTING WebSocket from its error handler, which can recursively re-emit errors on Node 22.
