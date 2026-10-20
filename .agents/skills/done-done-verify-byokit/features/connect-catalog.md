# App catalog and OAuth lifecycle

A consumer app lists the providers it chooses with `catalog(sources)`, using `knownApps` or its own selected `mcpDirectory(url)`. MCP OAuth sign-in supports app-side revocation on disconnect and a typed step-up flow after an `insufficient_scope` response, without discarding the old grant before replacement succeeds.

## Sub-features

- `catalog-known`: `catalog([knownApps])` returns the seven presets with their `auth` kind and makes no request.
- `catalog-directory`: `mcpDirectory(url)` reads nothing until listed, then follows `metadata.nextCursor`; unsignable registry-shape entries and a known id keep the existing behavior.
- `catalog-connect`: a listed directory app signs in through `connectLoopback` (discovery, registration, PKCE, token) and `connect(app).mcp()` lists its tools.
- `disconnect-revoke`: `disconnect()` posts refresh then access token to the discovered RFC 7009 endpoint, removes local state, and reports failure.
- `step-up`: MCP `insufficient_scope` exposes the WWW-Authenticate scope hint; `stepUp()` requests the union and retains the previous grant until callback exchange succeeds.
- `catalog-refused`: a directory answering `500` or another shape rejects with `ConnectError` `catalog`; an unreachable one with `network`.

## How to get to it (user POV)

- `catalog([knownApps, mcpDirectory(url)])`, then `connectLoopback(app, { store, person, open })` or `connect(app, ...)`. On `insufficient_scope`, call `stepUp(error.requiredScopes ?? [...])`; inspect the typed `disconnect()` result (packages/connect/README.md, "List apps to connect").

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Run and capture.** The integration journey uses built public entries and real loopback OAuth, directory and MCP HTTP servers: `feature=connect-catalog; entry=@byokit/connect; drive=(sh scripts/test.sh 'packages/connect/test/*.test.ts')`, then SKILL.md Evidence's capture block. It covers existing catalog behavior plus accepted and failed app revocation, the typed scope challenge, and successful step-up. Exit code `0`.
- **Revocation/step-up shows.** Refresh then access token reach `/revoke`; a 503 returns `{ revokedAtApp: false, reason: 'failed' }` while local state is deleted. A 403 scope hint yields `ConnectError` `insufficient_scope`; the old token works until the new scoped callback finishes.

## Gotchas

- Never point a drive at a real directory or connector service: listing a real one is the host's choice and a separate proof.
