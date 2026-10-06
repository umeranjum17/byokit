# Changelog

## Unreleased

- Add typed Gmail read and search (`MailReader`) on a connection: envelopes, one bounded body, opaque page tokens.
- Add owner-bound mail history and export (`MailHistory`): cross-page envelopes and `json`/`csv` export, foreign principals denied before any fetch.

## 0.2.0 (2026-10-01)

- FIX: Preserve provider refresh-token lifetimes and sanitized OAuth error causes for setup guidance.
- Add a client-details check without a user grant, with plain outcomes for accepted, rejected and uncertain replies.

## 0.1.0 (2026-10-01)



- Document a secrets-sealed desktop store and verify encrypted refresh-token persistence.
- Add per-person third-party sign-in, token refresh and typed remote MCP connections.

- OAuth authorization-code sign-in with S256 PKCE, protected-resource discovery and dynamic client registration.
- App-supplied redirects and an optional Node loopback helper; the host supplies each person's keystore.
- Single-flight refresh, rotating refresh tokens, disconnect and full typed MCP client pass-through.
