# @byokit/connect

Connect a person's online files, mail, calendar, notes, designs, code or other remote account.
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

## Test-only endpoint overrides

For local integration tests only, `ConnectOptions.endpoints` accepts full provider URLs; omitted values use production endpoints. For example, emulate 0.12.2 serves Google authorize at `http://localhost:4000/o/oauth2/v2/auth`, token at `http://localhost:4000/oauth2/token`, and Gmail API base at `http://localhost:4000/gmail/v1`. Pass the same `endpoints` object to `MailReader` or `MailSender` to route Gmail calls to its Google API. `Connection.apiBase` exposes the configured provider API base for app-owned calls; the kit itself makes no GitHub REST API calls. GitHub device-code and token URLs can be overridden for a local device-flow server because emulate 0.12.2 does not implement those routes.

## Sign in with an app-supplied redirect

```ts
import { connect } from '@byokit/connect';
import type { Keystore } from '@byokit/secrets';

// Supply your app's store, scoped to this person on this device.
declare const store: Keystore;
const drive = connect('drive', {
  store,
  person: 'Umer',
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
`drive` (`drive.file`), `gmail` (read-only; pass `scopes` to send) and `calendar` (events). The host owns
Google consent-screen publishing and API enablement. The kit does not probe
undocumented provider pages or impose a product-specific approval policy.

`notion`, `canva` and arbitrary HTTPS MCP URLs discover their protected-resource
metadata, authorization server and dynamic registration endpoint. If the server
does not offer registration, pass the app's registered `client`. Custom `Provider`
objects can supply `oauth` endpoints, an `issuer`, scopes and extra authorization
parameters. Options `scopes` override the preset/discovered scopes; security
parameters (`state`, PKCE, response type, client and redirect) cannot be overridden
through `extra`. A sign-in with explicitly incomplete granted scopes is not saved.

## The house Google client

One Google OAuth client serves every Google route the house runs: this kit's Gmail
reader and sender, and Crewhouse's Google connections.

- **Client:** type **Desktop app**, in the house's own Google Cloud project, with the
  Gmail, Calendar and Drive APIs enabled. Desktop clients accept any loopback port, so
  `connectLoopback` needs no redirect registration.
- **Consent:** audience External, published (*In production*; *Testing* grants stop
  after 7 days). The consent screen lists `gmail.readonly`, `gmail.send`,
  `calendar.events` and `drive.file`. Each connection still asks for one service;
  sending adds `gmail.send` through `scopes`.
- **Secret:** the JSON Google offers to download, unchanged, at
  `~/.config/byokit/google-oauth-client.json`, mode 600. Never in a repository, a log
  or a test HOME.

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectLoopback, googleClientFile } from '@byokit/connect/node';
import type { Keystore } from '@byokit/secrets';

declare const store: Keystore;
declare const yourApp: { openExternal(url: string): Promise<void>; setUpGoogle(): never };

const client = await googleClientFile(join(homedir(), '.config', 'byokit', 'google-oauth-client.json'));
if (!client) yourApp.setUpGoogle(); // No file yet: Google is not set up on this computer.
const attempt = await connectLoopback('gmail', { store, person: 'Umer', client,
  scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  open: url => yourApp.openExternal(url) });
await attempt.done; // Then MailReader/MailSender on attempt.connection.
```

`googleClientFile(path)` reads only the path the host passes. It returns `null` when
the file is absent, and refuses a file other users can read, a non-regular file
at the path, or any client type other than Desktop app, with a plain message
that never repeats the file's contents.

## Check app details and inspect grant lifetime

```ts
import type { Connection } from '@byokit/connect';

declare const drive: Connection;
declare const enteredClientId: string;
declare const enteredClientSecret: string;

const check = await drive.verifyClient(); // Uses options.client.
// Or check newly entered details without changing the saved connection:
const entered = await drive.verifyClient({ id: enteredClientId, secret: enteredClientSecret });
const grant = await drive.grant(); // Trusted app code only; contains credentials.
```

`grant()` returns a snapshot or `null` and makes no provider call. Times are Unix
milliseconds. `refreshTokenExpiresIn` preserves the provider's
`refresh_token_expires_in` seconds; `refreshTokenExpiresAt` is its absolute deadline.
Sign-in/refresh responses calculate the deadline when received, and omitted refresh
lifetime fields retain the previous deadline. Expired refresh grants require
sign-in without sending another refresh request.

`verifyClient(client?)` uses the selected token endpoint with a deliberately
nonexistent refresh grant, without reading or changing the person's grant. For
Google, `invalid_client` yields `outcome: 'invalid'`; a 400 `invalid_grant` yields
`'valid'`; network failures and all other replies yield `'inconclusive'`. Each
outcome includes a plain `message`; failed provider replies may carry the same
sanitized diagnostic `cause` as `ConnectError`. A secret is required. This checks
client authentication only; it does not check consent-screen publishing, enabled
APIs, redirect registration or scopes. Tests use injected fake endpoints only.

## Connect GitHub with a device code

```ts
import { connect, deviceSignIn } from '@byokit/connect';
import type { Keystore } from '@byokit/secrets';

declare const store: Keystore;
const options = { store, person: 'Umer', client: { id: 'your-github-oauth-app-client-id' }, scopes: ['repo'] };
const flow = await deviceSignIn('github', options);
// Show flow.userCode and flow.verificationUri (github.com/login/device);
// the person types the code there on any device.
await flow.finish(); // Resolves once they approve; call flow.cancel() when the sheet closes.

const github = connect('github', options);
await github.connected(); // true
```

`deviceSignIn(provider, options)` starts an RFC 8628 device sign-in and returns
`{ userCode, verificationUri, expiresAt, finish, cancel }`; `expiresAt` is Unix
milliseconds. It needs the app's own OAuth client ID with device flow enabled;
there is no house GitHub client, and no `redirectUri`. `finish()` polls at the
provider's interval, adds 5 seconds on `slow_down`, and keeps waiting through a
poll that cannot get through. Only an approved code stores a grant, in the same
keystore record `connect()` reads, so `connected()`, `grant()` and `token()`
work afterwards. An expired code rejects with `ConnectError` code `expired`; a
person pressing Cancel on GitHub, or `cancel()`, rejects with `declined`. Both
store nothing. Any provider with `device: { code, token }` endpoints works the
same way.

## Loopback on a computer

```ts
import { connectLoopback } from '@byokit/connect/node';
import type { Keystore } from '@byokit/secrets';

declare const store: Keystore;
declare const yourApp: { openExternal(url: string): Promise<void> };

const attempt = await connectLoopback('notion', {
  store, person: 'Umer',
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
  store, person: 'Umer', redirectUri: 'https://your-app.example/connect/callback',
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

## List apps to connect

```ts
import { catalog, connect, knownApps, mcpDirectory } from '@byokit/connect';
import type { Keystore } from '@byokit/secrets';

declare const store: Keystore;
const apps = await catalog([knownApps, mcpDirectory('https://directory.your-app.example/v0/servers?version=latest')]);
const app = apps[0]; // { id, name, icon?, auth, ...the Provider connect() takes }
const connection = connect(app, { store, person: 'Umer', redirectUri: 'https://your-app.example/connect/callback' });
const flow = await connection.signIn(); // Or connectLoopback(app, ...); deviceSignIn(app, ...) when app.auth is 'device'.
```

`catalog(sources)` lists the apps of the sources the host picks, in that order; an
id listed twice keeps its first entry. Nothing is listed, and nothing is read, by
default. Every listed app is a `Provider`, so it signs in through the same
`connect()`, `connectLoopback()` and `deviceSignIn()` as above, under the same
keystore record as the preset of that id. `auth` says how: `oauth` needs the app's
registered `client`, `discovery` finds sign-in from the app's MCP server and
registers itself where offered, `device` shows a typed code. `icon` is an HTTPS
image address from the listing; render it as untrusted content.

- `knownApps` lists the kit's presets (`providers`) and reads nothing.
- `mcpDirectory(url, { fetch?, timeoutMs? })` reads a remote MCP directory that
  answers in the MCP registry's `GET /v0/servers` shape, following
  `metadata.nextCursor` (at most 100 pages), only when listed. It keeps servers
  with a streamable HTTP remote and no address variables or required headers;
  local packages, legacy SSE remotes and key-header servers are left out. The URL
  must be HTTPS (or loopback); for the MCP registry add `version=latest`.
- Any object with `list(): Promise<CatalogApp[]>` is a source, such as the host's
  own managed connector directory behind its server.

A directory that fails or answers in another shape rejects with `ConnectError`
code `catalog` (with its `status`), an unreachable one with `network`; the whole
`catalog()` call rejects with it, so list a source on its own to keep the rest.
The host vouches for the directories it names: signing in to a listed app talks
to the server that listing names.

## Read and search Gmail

```ts
import { connect, MailReader } from '@byokit/connect';
import type { Keystore } from '@byokit/secrets';
declare const store: Keystore;
const gmail = connect('gmail', { store, person: 'Umer', redirectUri: 'https://your-app.example/connect/callback' });
const mail = new MailReader(gmail, { maxBodyChars: 20_000 });
const page = await mail.search('invoice'); // Gmail syntax; follow page.nextPageToken.
const message = await mail.get(page.messages[0].id); // Envelope plus bounded body.
```

`search`/`list` return one page of envelopes; `get` adds the decoded body, cut at
`maxBodyChars` (`body.truncated` says so). A 401 retries once, then reads as
signed-out; rate limits carry `until` from `Retry-After`.

## Send Gmail, one approval per message

```ts
import { connect, MailSender, type OutgoingMail } from '@byokit/connect';
import type { Keystore } from '@byokit/secrets';
declare const store: Keystore;
declare function askPerson(mail: OutgoingMail): Promise<boolean>; // The host's own confirm step.
const gmail = connect('gmail', { store, person: 'Umer', redirectUri: 'https://your-app.example/connect/callback',
  scopes: ['https://www.googleapis.com/auth/gmail.send'] });
const sender = new MailSender(gmail, mail => askPerson(mail));
const sent = await sender.send({ to: 'crew@example.test', subject: 'Invoice paid', body: 'Thanks, Umer' });
```

Sending needs the `gmail.send` scope, requested through `scopes` (a grant without it
fails sign-in with `scope`). Every `send` asks the approval once with the frozen
message it will encode; only `true` sends, and anything else, including a throw,
is `MailError` code `denied` before any token or provider call. One message per
call: no batching, queue, retry or background send. A network failure leaves the
outcome unknown, so check Sent before asking to send again. Plain-text bodies to
bare addresses only: no cc/bcc, display names, HTML, attachments, replies in a
thread or labels.

## Owner-bound history and export

```ts
import { MailHistory, type Connection } from '@byokit/connect';
declare const gmail: Connection; // Signed in for Umer.
const history = new MailHistory(gmail, { owner: 'Umer' });
const rows = await history.messages({ principal: 'Umer', query: 'invoice' });
const csv = await history.export({ principal: 'Umer', query: 'invoice', format: 'csv' }); // Or 'json'.
```

The host binds `owner` once; every call names its `principal` and anything else
is denied (`HistoryError` code `denied`) before any provider fetch. Retrieval
pages through `search`/`list` up to `maxMessages` (default 100, at most 500).
Export writes envelopes only — message bodies are never exported. Provider
failures keep their `MailError` code, `status` and `until` under `HistoryError`.

## Refresh, errors and storage

Refresh runs when the token is within one minute of expiry, or after a 401. It is
single-flight across handles sharing the same keystore object/person/connection.
Rotated refresh tokens are persisted; responses that omit a refresh token keep the
previous one. Transient failures preserve the sign-in. Only explicit
`invalid_grant` removes it. An unexpired token can still be used after a network
failure; an expired token is never returned. Tokens without `expires_in` remain
valid until rejected, then refresh if possible. No background timer is needed.

`ConnectError.code` is a typed app diagnostic and `message` is a plain sentence.
OAuth errors expose an optional typed `cause` with `error` and
`error_description`, sanitized against supplied/returned credentials and URLs.
The message remains a plain sentence. Treat provider descriptions as untrusted
text; they are diagnostics for the host, not ready-to-render UI. No errors or
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
one handle per member/app, listing the apps from `catalog([knownApps])` (add `mcpDirectory(url)`
or the host's own source to list more). Pass the member's keystore and member ID, the house Google
client from `googleClientFile` when applicable, and Crewhouse's callback address. Keep
flow handles in the host's callback routing table until completion/cancellation.
Crewhouse retains its own connection screen, Google setup guidance and tool gates.
For remote apps, call `mcp()` and use `listTools`/`callTool` with their full results;
for Gmail use `MailReader`/`MailSender` below; for Calendar use `token()` until its typed kit
sits on this connection. No raw OAuth, refresh or MCP transport needs to remain in the consumer.

## Verification

```sh
npm run build
npm run check
sh scripts/test.sh 'packages/connect/test/*.test.ts'
```

`packages/connect/test/journey-connect.test.ts` drives the built package the way a
host app does — `connect`/`signIn`/`deviceSignIn`/`token`/`mcp`, `catalog` over the known apps and a
loopback MCP directory (one listed app connected end to end), the loopback listener, the house
Google client, `MailReader`/`MailSender` and `MailHistory`. Fake providers and a real
loopback callback only. It covers PKCE/state and exact-callback binding, per-person
isolation, refresh races and revocation, discovery/DCR/resource binding, rich MCP
JSON/SSE responses, the approved/denied send, owner-bound history and browser
bundling. No real accounts or outbound network calls are used. Live
provider/device sign-ins are not claimed by these tests.
