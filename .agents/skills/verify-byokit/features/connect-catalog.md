# App catalog

A consumer app lists apps through `catalog(sources)`: `knownApps`, the statically reviewed `reviewedApps` MCP Registry-shaped vendor list, and caller-selected `mcpDirectory(url)`. It connects one app, handles a 403 `insufficient_scope` through `stepUp()` without losing the old grant, and disconnects with an explicit app-revocation outcome.

## Sub-features

- `catalog-known`: `catalog([knownApps])` returns the seven presets with their `auth` kind and makes no request.
- `catalog-reviewed`: `catalog([reviewedApps])` returns only current, live-probed, DCR-capable entries with descriptions and vendor icons; candidates failing initialize or metadata checks are omitted.
- `disconnect-revoke`: `disconnect()` posts refresh then access token to RFC 7009, removes the local record, and reports failure without hiding it.
- `catalog-directory`: `mcpDirectory(url)` reads nothing until listed, then follows `metadata.nextCursor`; servers the kit cannot sign in to (local package, required header, legacy SSE, plain HTTP) are left out, and a known id keeps the preset.
- `catalog-connect`: a listed directory app signs in through `connectLoopback` (discovery, registration, PKCE, token) and `connect(app).mcp()` lists its tools.
- `catalog-refused`: a directory answering `500` or another shape rejects with `ConnectError` `catalog`; an unreachable one with `network`.
- `step-up`: MCP `insufficient_scope` includes the WWW-Authenticate scope hint; `stepUp()` requests the union and retains the previous grant until callback exchange succeeds.

## How to get to it (user POV)

- `catalog([knownApps, reviewedApps, mcpDirectory(url)])`, then `connectLoopback(app, { store, person, open })` or `connect(app, ...)`. On `insufficient_scope`, call `stepUp(error.requiredScopes ?? [...])`; inspect the typed `disconnect()` result (packages/connect/README.md, "List apps to connect").

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-connect-catalog.mjs"` importing `catalog`, `knownApps`, `mcpDirectory`, `connect`, `ConnectError` from `@byokit/connect`, `connectLoopback` from `@byokit/connect/node` and `createServer` from `node:http`. First line after imports wraps `globalThis.fetch` so any non-`127.0.0.1` URL throws. Start two loopback servers:
  - an MCP app: `/mcp` answers `401` with `www-authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` until it sees the fixture bearer, then JSON-RPC `initialize` (with an `mcp-session-id`), `202` for notifications and `tools/list` with one tool; `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` (issuer = origin, S256), `/register` (`201`, `token_endpoint_auth_method: 'none'`), `/authorize` (`302` back to `redirect_uri` with `state` and a code), `/token` (fixture bearer tokens);
  - a directory: `/v0/servers` page 1 lists the MCP app (`title`, an icon, a streamable HTTP remote), a package-only server, a required-header server, an SSE-only server and a server named `drive`, with `metadata.nextCursor: 'page-2'`; page 2 lists one more HTTPS server. A switch makes it answer `500`.
  Print the request count before listing, the listed ids with `auth`, the listed app, the page cursors, `store` size after `connectLoopback` (its `open` fetches the authorize URL with `redirect: 'manual'` and follows the `location`), the tool names from `connect(app, { store, person }).mcp()`, then the `500` and closed-port refusals' code, status and message. Exit 1 unless one tool is listed.
- **Run and capture.** The integration journey uses built public entries and real loopback OAuth, directory and MCP HTTP servers: `feature=connect-catalog; entry=@byokit/connect; drive=(sh scripts/test.sh 'packages/connect/test/*.test.ts')`, then SKILL.md Evidence's capture block. It covers catalogue ordering and exclusions, accepted and failed app revocation, the typed scope challenge, and successful step-up. Exit code `0`.
- **Listing shows.** Seven known presets and 10 reviewed vendor servers; the live probe records 401 + DCR metadata for each included vendor and drops Atlassian (no RFC 9728 metadata) and Calendly (404). Caller directories remain separate and explicitly trusted.
- **Connect shows.** `stored: 1`, the fixture tool name.
- **Revocation/step-up shows.** Refresh then access token reach `/revoke`; a 503 returns `{ revokedAtApp: false, reason: 'failed' }` while local state is deleted. A 403 scope hint yields `ConnectError` `insufficient_scope`; the old token works until the new scoped callback finishes.

## Gotchas

- Never point a drive at a real directory or connector service: listing a real one is the host's choice and a separate proof.
