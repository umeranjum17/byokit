# Changelog

## Unreleased

## 0.8.0 (2026-10-18)

- FIX: `disconnect()` revokes refresh and access tokens at the MCP app before local deletion and reports whether app-side revocation succeeded.
- FEAT: MCP `insufficient_scope` challenges expose scope hints; `stepUp()` requests added scopes while keeping the current grant until replacement sign-in succeeds.
FIX: `catalog()` now includes the reviewed, live-probed MCP vendors; `disconnect()` revokes at the app before local deletion and reports failures; `stepUp()` requests added scopes while retaining the old grant until sign-in completes.

## 0.7.0 (2026-10-18)

- FEATURE: The connect kit takes a test-only endpoint setting for Google and GitHub.

## 0.6.0 (2026-10-17)

- FEAT: `catalog(sources)` lists apps a person can connect from the sources an app picks: `knownApps` (the kit's own presets, no network) and `mcpDirectory(url)` (a remote MCP directory in the MCP registry's shape, read only when listed). Each listed app has an id, name, icon and sign-in kind, and connects through the usual `connect()`, `connectLoopback()` or `deviceSignIn()`.
- Dependency update: pins @modelcontextprotocol/sdk 1.32.1.

## 0.5.1 (2026-10-17)

- Dependency update: pins @byokit/secrets 0.5.2.

## 0.5.0 (2026-10-17)

- FEAT: `deviceSignIn(provider, options)` connects a person with an RFC 8628 device code: it returns `{ userCode, verificationUri, expiresAt, finish(), cancel() }`, polls with the app's own OAuth client ID (pending waits, `slow_down` adds 5 s), and stores the grant in the person's keystore only when they approve. An expired code rejects with `ConnectError` `expired`; a person cancelling on the provider's page, or `cancel()`, rejects with `declined`, and neither stores anything. New `github` provider (`device` endpoints on github.com) and `Provider.device`; `ConnectOptions.redirectUri` is now optional (`signIn()` still requires it). RFC 8628 error codes stay readable in `ConnectError.cause`. The `expired` message now reads "This sign-in has expired. Start again."

## 0.4.0 (2026-10-12)

- Dependency update: pins @byokit/secrets 0.5.1.

- FEAT: One documented house Google client route: `googleClientFile(path)` in `@byokit/connect/node` reads Google's downloaded Desktop-app JSON (mode 600) for Gmail and every other Google preset, returns `null` when it is absent, and refuses a file other users can read, a non-regular file, or another client type.

## 0.3.0 (2026-10-06)

- Add approval-gated Gmail send (`MailSender`): one plain-text message per call, sent only after the host's approval returns `true` for that exact message.

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
