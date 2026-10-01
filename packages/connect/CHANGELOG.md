# Changelog

## Unreleased

- Document a secrets-sealed desktop store and verify encrypted refresh-token persistence.
- Add per-person third-party sign-in, token refresh and typed remote MCP connections.

## 0.1.0 (2026-09-30)

- OAuth authorization-code sign-in with S256 PKCE, protected-resource discovery and dynamic client registration.
- App-supplied redirects and an optional Node loopback helper; the host supplies each person's keystore.
- Single-flight refresh, rotating refresh tokens, disconnect and full typed MCP client pass-through.
