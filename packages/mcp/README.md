# @byokit/mcp

Hosted tools and resources over streamable HTTP. The official MCP TypeScript SDK owns
the protocol, including initialization, event streams and session termination. This kit
adds device sign-in, authentication on every request and sessions bound to one person.
It runs on Node 22.18 or later; it is a server kit, with no browser or phone entry.
The initial manifest is held private at `0.1.0`; the release lane prepares its first
publication, removes that hold and rolls the Unreleased notes. The install snippets
below apply after that publication.

## Install snippets

```sh
npm install @byokit/mcp zod
```

After device approval, set `MCP_URL` to your hosted HTTPS endpoint and `MCP_TOKEN` to
the returned access token in your shell's private environment. These are one-line adds:

```sh
# Claude Code
claude mcp add --transport http demo "$MCP_URL" --header "Authorization: Bearer $MCP_TOKEN"
# Codex
codex mcp add demo --url "$MCP_URL" --bearer-token-env-var MCP_TOKEN
# Cursor (opens the install dialog; macOS uses open, Linux uses xdg-open)
node --input-type=module -e 'import {spawnSync} from "node:child_process"; const config=Buffer.from(JSON.stringify({url:process.env.MCP_URL,headers:{Authorization:`Bearer ${process.env.MCP_TOKEN}`}})).toString("base64"); spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [`cursor://anysphere.cursor-deeplink/mcp/install?name=demo&config=${encodeURIComponent(config)}`], {stdio:"ignore"});'
```

The header and install-link forms save the token in the client's configuration. Keep
that configuration private. No client launches a device flow automatically yet.
Command formats: [HTTP add](https://code.claude.com/docs/en/mcp),
[remote add](https://developers.openai.com/codex/mcp/),
[install links](https://prod.cursor.com/docs/mcp/install-links).

## Minimal server

```ts
import { createServer } from 'node:http';
import { z } from 'zod';
import { overrideStore } from '@byokit/secrets';
import { deviceFlow, hostedMcp } from '@byokit/mcp';

// In-memory demo only. Supply your app's secrets backend for persistent grants.
const auth = deviceFlow({
  store: overrideStore({}),
  verificationUri: 'http://127.0.0.1:3000/approve',
});
const kit = hostedMcp({
  name: 'demo', version: '0.1.0', url: 'http://127.0.0.1:3000/mcp', auth, device: auth,
  mount(m) {
    m.tool('hello', { inputSchema: { name: z.string() } }, async ({ name }, context) => {
      await context.progress(1, 1);
      return { content: [{ type: 'text', text: `${context.principal.name} says hello to ${name}.` }] };
    });
    m.resource('profile', 'demo://profile', { mimeType: 'text/plain' }, (uri, context) => ({
      contents: [{ uri: uri.href, text: context.principal.name, mimeType: 'text/plain' }],
    }));
  },
});
const http = createServer((req, res) => { void kit.handle(req, res); });
http.listen(3000, '127.0.0.1');

// In your authenticated account page, after Umer explicitly approves the typed code:
function approveForDemoUser(typedCode: string) {
  auth.approve(typedCode, { id: 'umer', name: 'Umer' });
}
// On shutdown: await kit.close(); http.close();
```

The host owns its listener, account page and deployment. Use HTTPS in production and
pass the public endpoint as `url`. The kit validates Host and Origin against that URL;
your reverse proxy must preserve the public Host. Mount the handler at that path and its
device subpaths. It does not serve the approval page or implement an account login.

## Auth flow

1. POST JSON `{}` to `/mcp/device/code`. The reply contains `device_code`, `user_code`,
   `verification_uri`, `expires_in` and `interval` (seconds).
2. Show the verification address and user code. The person signs in to the host's account
   page and explicitly approves. That authenticated, CSRF-protected page calls
   `auth.approve(userCode, principal)`; the device cannot choose its own principal.
3. POST JSON `{ "device_code": "…" }` to `/mcp/device/token`, no faster than `interval`.
   `pending` means approval is still needed; `busy` means wait before polling again.
   Approval yields `access_token`, `token_type: "Bearer"` and `expires_in` exactly once.
4. Send `Authorization: Bearer …` on every POST, GET and DELETE to `/mcp`. The SDK
   negotiates initialization and supplies the session header. Revoke a grant with
   `await auth.revoke(token)`; expired or revoked tokens stop working on existing sessions.

The same flow is available directly as `begin()`, `approve()` and `poll()`. Device codes
expire after five minutes; access tokens after 30 days; pending polls default to five
seconds. All are configurable. The kit keeps only device-code hashes in its pending map
and stores SHA-256 access-token hashes as names in the supplied `@byokit/secrets`
`Keystore`. No plaintext access token is saved. A sealed `fileStore({ path, passphrase })`
or an OS keyring backend can persist these grants; the host passes every path and secret.
The kit does not read environment variables, log credentials, or inspect other apps.

`McpError.code` distinguishes `unauthorized`, `expired`, `invalid`, `pending`, `busy`,
`session` and `failed`; its message is a fixed plain sentence. Unknown handler and
storage exceptions become `failed`, without exposing their original message or stack.
Tools return an error result; resources return a protocol error. Successful handler
results are app data: the host must keep credentials out of them and its own HTTP logs.

`Authenticator.authenticate(token)` is the seam for a future authorization scheme.
OAuth discovery, redirects and refresh are not implemented. This device flow is a kit
setup API, not an OAuth authorization server.

## Sessions and deployment

Each initialization mounts fresh definitions on an SDK server. Callbacks receive the
current request's principal, cancellation signal and a progress sender. Concurrent
requests have separate contexts. Sessions last 30 minutes by default (`sessionMs`) and
cannot be reused by another person. Device approval and sessions are in memory: use one
process, or sticky routing to it. Restarting loses pending approvals and sessions; saved
token grants remain in the host store. Stream resumption and distributed sessions are
not offered in this version. A stream is authorized when its request opens; the host
should cancel long-running work when account access changes.

`maxPending` and `maxSessions` default to 1000. Put the device endpoints behind your
host's per-source rate limits. Tokens have no implicit tool scopes; the host enforces its
permissions in callbacks using the supplied principal. `close()` ends the kit's sessions
and refuses further requests, while the host owns closing its listener.

## Checks

From the repository root:

```sh
export TMPDIR=$(mktemp -d /tmp/bk-XXXX)
trap 'rm -rf "$TMPDIR"' EXIT
npm run build
npm run check
sh scripts/test.sh 'packages/mcp/test/*.test.ts'
npm run smoke:pack
```

Tests use the real SDK client and loopback HTTP, with a fake account and isolated sealed
storage. No account, external network or model is required.
