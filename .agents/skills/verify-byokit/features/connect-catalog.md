# App catalog

A consumer app lists the apps a person can connect through `@byokit/connect`'s `catalog(sources)`: `knownApps` (the kit's presets, no network) and `mcpDirectory(url)` (a remote MCP directory in the MCP registry's `GET /v0/servers` shape). It then connects one listed app with the kit's own sign-in, and calls its MCP tools.

## Sub-features

- `catalog-known`: `catalog([knownApps])` returns the seven presets with their `auth` kind and makes no request.
- `catalog-directory`: `mcpDirectory(url)` reads nothing until listed, then follows `metadata.nextCursor`; servers the kit cannot sign in to (local package, required header, legacy SSE, plain HTTP) are left out, and a known id keeps the preset.
- `catalog-connect`: a listed directory app signs in through `connectLoopback` (discovery, registration, PKCE, token) and `connect(app).mcp()` lists its tools.
- `catalog-refused`: a directory answering `500` or another shape rejects with `ConnectError` `catalog`; an unreachable one with `network`.

## How to get to it (user POV)

- `catalog([knownApps, mcpDirectory(url)])`, then `connectLoopback(app, { store, person, open })` or `connect(app, ...)` (packages/connect/README.md, "List apps to connect").

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-connect-catalog.mjs"` importing `catalog`, `knownApps`, `mcpDirectory`, `connect`, `ConnectError` from `@byokit/connect`, `connectLoopback` from `@byokit/connect/node` and `createServer` from `node:http`. First line after imports wraps `globalThis.fetch` so any non-`127.0.0.1` URL throws. Start two loopback servers:
  - an MCP app: `/mcp` answers `401` with `www-authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` until it sees the fixture bearer, then JSON-RPC `initialize` (with an `mcp-session-id`), `202` for notifications and `tools/list` with one tool; `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` (issuer = origin, S256), `/register` (`201`, `token_endpoint_auth_method: 'none'`), `/authorize` (`302` back to `redirect_uri` with `state` and a code), `/token` (fixture bearer tokens);
  - a directory: `/v0/servers` page 1 lists the MCP app (`title`, an icon, a streamable HTTP remote), a package-only server, a required-header server, an SSE-only server and a server named `drive`, with `metadata.nextCursor: 'page-2'`; page 2 lists one more HTTPS server. A switch makes it answer `500`.
  Print the request count before listing, the listed ids with `auth`, the listed app, the page cursors, `store` size after `connectLoopback` (its `open` fetches the authorize URL with `redirect: 'manual'` and follows the `location`), the tool names from `connect(app, { store, person }).mcp()`, then the `500` and closed-port refusals' code, status and message. Exit 1 unless one tool is listed.
- **Run and capture.** `feature=connect-catalog; entry=@byokit/connect; drive=(node "$scratch_dir/verify-connect-catalog.mjs")`, then SKILL.md Evidence's capture block. Exit code `0`.
- **Listing shows.** `requests before list: 0`, the seven preset ids (`drive` as `oauth`, `notion` as `discovery`, `github` as `device`) then the two directory ids, cursors `[null, 'page-2']`.
- **Connect shows.** `stored: 1`, the fixture tool name.
- **Refusals show.** `catalog | 500 | Could not load the list of apps. Try again later.` and `network | Could not reach the app. Check your connection and try again.`

## Gotchas

- Never point a drive at a real directory or connector service: listing a real one is the host's choice and a separate proof.
