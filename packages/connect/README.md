# @byokit/connect

Connect a person's Google, Drive, Notion, Canva or other remote MCP account.
Sign-in opens the provider's own page. Credentials stay in the keystore the app
passes, scoped to that person on their device. There is no account pool, proxy,
ambient credential lookup, logging or extra opt-in switch.

```sh
npm install @byokit/connect
```

The main export is portable to Node, Electron, browsers and PWAs. It needs `fetch`,
Web Crypto, `btoa`, and URL APIs; native hosts must provide those globals before
importing it. The optional `/node` export owns only the loopback callback listener.
The main entry has no runtime dependency on Node or keystore backends.

## Sign in with an app-supplied redirect

```ts
import { connect } from '@byokit/connect';
import type { Keystore } from '@byokit/secrets';

// Supply your app's store, scoped to this person on this device.
declare const store: Keystore;
const drive = connect('drive', {
  store,
  person: 'person-42',
  redirectUri: 'https://your-app.example/connect/callback',
  client: { id: 'your-google-client-id', secret: 'your-google-client-secret' },
});

const flow = await drive.signIn();
// Open flow.url in the host's browser/auth session.
// Route its complete callback URL to the same flow instance:
await flow.finish('https://your-app.example/connect/callback?state=...&code=...');

const accessToken = await drive.token(); // Trusted API calls only; never show/log it.
await drive.disconnect();
```

`connect(target, options)` creates a handle. `signIn()` returns `{ url, redirectUri,
finish, cancel }`. Call `cancel()` when closing the sign-in sheet. Calls to
`connected()`, `token()` and `disconnect()` work after reconstructing the handle
with the same store, person, target and configured client ID. The redirect port
can change without losing the saved connection. A newer sign-in invalidates the
older flow; callbacks have a 15-minute deadline and can be used only once.

Google requires the host's registered client. Use a Desktop client with loopback,
or register the exact HTTPS/native redirect for that client. Presets keep Google's
offline/consent parameters and request one service at a time: `google` (identity),
`drive` (`drive.file`), `gmail` (read-only) and `calendar` (events). The host owns
Google consent-screen publishing and API enablement. The kit does not probe
undocumented provider pages or impose a product-specific approval policy.

`notion`, `canva` and arbitrary HTTPS MCP URLs discover their protected-resource
metadata, authorization server and dynamic registration endpoint. If the server
does not offer registration, pass the app's registered `client`. Custom `Provider`
objects can supply `oauth` endpoints, an `issuer`, scopes and extra authorization
parameters. Options `scopes` override the preset/discovered scopes; security
parameters (`state`, PKCE, response type, client and redirect) cannot be overridden
through `extra`. A sign-in with explicitly incomplete granted scopes is not saved.

## Loopback on a computer

```ts
import { connectLoopback } from '@byokit/connect/node';
import type { Keystore } from '@byokit/secrets';

declare const store: Keystore;
declare const yourApp: { openExternal(url: string): Promise<void> };

const attempt = await connectLoopback('notion', {
  store, person: 'person-42',
  open: url => yourApp.openExternal(url),
});
await attempt.done;
const connection = attempt.connection;
// Or attempt.cancel() to close the listener and reject done.
```

The listener binds only `127.0.0.1`, with an OS-assigned port, and closes on success,
cancel, failure or timeout. The host opens the browser; the kit never runs a CLI.
Use `connect()` with `redirectUri` for web/PWA or native auth sessions instead.

## Full typed MCP client

```ts
import { connect, CallToolResultSchema } from '@byokit/connect';
import type { Keystore } from '@byokit/secrets';

declare const store: Keystore;

const notion = connect('notion', {
  store, person: 'person-42', redirectUri: 'https://your-app.example/connect/callback',
});
// Sign in once, then reconstruct this handle across app restarts.
const mcp = await notion.mcp({
  clientInfo: { name: 'your-app', version: '1' },
  clientOptions: { capabilities: {} },
  configure: client => { /* register SDK request/notification handlers here */ },
});
try {
  const page = await mcp.listTools(); // Follow nextCursor when present.
  const result = await mcp.callTool({ name: page.tools[0].name, arguments: {} }, CallToolResultSchema);
  // result preserves text, images, structuredContent, isError and other MCP data.
  const resources = await mcp.listResources();
  const prompts = await mcp.listPrompts();
} finally {
  await mcp.close();
}
```

`mcp()` returns the official SDK `Client`, pinned at 1.31.0. Its typed tools,
resources, prompts, pagination, cancellation, sampling/elicitation handlers,
notifications, generic schema-validated `request()` and transport negotiation stay
available. The package re-exports `Client` and the SDK's protocol types/schemas for
pass-through. Streamable HTTP supports JSON and SSE responses and session headers.
Every request obtains the person's current token, scoped to the connected resource.
A 401 triggers one refresh/retry; redirects are refused. Close clients before
`disconnect()` to release their streams. Arbitrary unauthenticated MCP servers and
legacy HTTP+SSE transports are outside this sign-in kit's initial scope.

## Refresh, errors and storage

Refresh runs when the token is within one minute of expiry, or after a 401. It is
single-flight across handles sharing the same keystore object/person/connection.
Rotated refresh tokens are persisted; responses that omit a refresh token keep the
previous one. Transient failures preserve the sign-in. Only explicit
`invalid_grant` removes it. An unexpired token can still be used after a network
failure; an expired token is never returned. Tokens without `expires_in` remain
valid until rejected, then refresh if possible. No background timer is needed.

`ConnectError.code` is a typed app diagnostic and `message` is a plain sentence.
OAuth errors never include provider bodies, callback codes or tokens. No errors or
tokens are logged. MCP results/errors are private application content and should
be treated accordingly. `fetch`, `now`, request and flow timeouts are injectable.

The keystore dependency supplies the shared TypeScript contract; no backend is
imported at runtime. Pass any `@byokit/secrets` backend (or a
host adapter implementing its `get`/`set`/`delete` contract). The kit writes one
JSON secret containing the grant, refresh tokens, scopes, issuer/endpoints and
client registration per person/provider/resource/client under a fixed-length hashed
name. Use a durable device
store; do not send this record to a shared server. See [SECURITY.md](SECURITY.md)
for concurrency and callback boundaries.

## Sealed desktop token storage

In Node or Electron's main process, wrap the host's durable store before passing
it to connect. This adapter writes only authenticated ciphertext, including after
refresh; the store's names are bound inside the sealed payload.

```ts
import { connect } from '@byokit/connect';
import { osKeyringSeal, type Keystore } from '@byokit/secrets/node';

// Your app's durable, per-person store; it receives ciphertext only.
declare const ciphertextStore: Keystore;
const seal = osKeyringSeal({ service: 'crewhouse-connect-Umer', dualWrap: true });
const store: Keystore = {
  async get(name) {
    const value = await ciphertextStore.get(name);
    if (value === null) return null;
    const record = JSON.parse(seal.decryptString(Buffer.from(value, 'base64')));
    if (record.name !== name || typeof record.secret !== 'string') throw new Error('Stored sign-in could not be opened.');
    return record.secret;
  },
  async set(name, secret) {
    const bytes = seal.encryptString(JSON.stringify({ name, secret }));
    await ciphertextStore.set(name, Buffer.from(bytes).toString('base64'));
  },
  delete: name => ciphertextStore.delete(name),
};
const notion = connect('notion', {
  store, person: 'Umer', redirectUri: 'https://your-app.example/connect/callback',
});
```

Keep one adapter/store instance per person and app, and use an app writer lock if
multiple processes share storage. Dual wrapping permits reads through an owner-only
host key when the keyring is locked; keep that key separate from ciphertext backups.
Omit `dualWrap` and pass `fallback: false` when an accessible OS keyring is required.
See [secrets' sealing guide](../secrets/README.md#seal-accounts-files-on-desktop) for
platform behavior, key protection and rotation. Sign in and refresh normally through
the connection handle; never persist its returned access token separately.

## Crewhouse adoption

Replace the OAuth, token-file and `RemoteMcp` portions of `src/connections.ts` with
one handle per member/app. Pass the member's keystore and member ID, the host's
registered Google client when applicable, and Crewhouse's callback address. Keep
flow handles in the host's callback routing table until completion/cancellation.
Crewhouse retains its own connection screen, Google setup guidance and tool gates.
For remote apps, call `mcp()` and use `listTools`/`callTool` with their full results;
for Gmail/Calendar use `token()` until their typed kits sit on this connection.
No raw OAuth, refresh or MCP transport needs to remain in the consumer.

## Verification

```sh
npm run build
npm run check
sh scripts/test.sh 'packages/connect/test/*.test.ts'
```

Tests use fake providers and a real loopback callback only. They cover PKCE/state,
replay/cancel/expiry, discovery/DCR/resource binding, refresh races and revocation,
per-person isolation, rich MCP JSON/SSE responses and browser bundling. No real
accounts or outbound network calls are used. Live provider/device sign-ins are not
claimed by these tests.
