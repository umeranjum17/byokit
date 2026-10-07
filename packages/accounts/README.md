<h1 align="center">@byokit/accounts</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/accounts"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/accounts?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node | Electron | browsers | React Native" src="https://img.shields.io/badge/platform-Node%20%7C%20Electron%20%7C%20browsers%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>Sign in with the AI plan you already pay for, inside your own app.</strong><br/>
ChatGPT and Claude Pro/Max on every platform (Claude needs Web Crypto); Grok, GitHub Copilot, Kimi and Meta on computers.
OpenRouter and Anthropic API keys are billed per use and require explicit app opt-in. Sign-ins go into your app's own store: on a computer (Node, Electron), in a browser
(a PWA, Electron's renderer) and on a phone (React Native and Expo, iOS and Android). One import; your bundler picks
the platform's side (`package.json`'s `react-native` and `browser` conditions).</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/pwa-1-signed-out.png" width="240" alt="The page &quot;byokit in a browser&quot;, signed out: &quot;ChatGPT isn't signed in yet.&quot; above a Sign in with ChatGPT button" />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/pwa-2-code.png" width="240" alt="The same page signing in: &quot;Signing in to ChatGPT…&quot;, &quot;On the ChatGPT page, type this code:&quot; WDJB-MJHT, an Open ChatGPT link and a Cancel button" />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/pwa-3-connected.png" width="240" alt="The same page signed in: &quot;ChatGPT is connected.&quot;, sara@example.com, plus plan, with Check the sign-in and Sign out buttons" />
</p>
<p align="center"><sub><a href="../../examples/pwa"><code>examples/pwa</code></a> signing in by device code in headless Chromium (Playwright), against the kit's stand-in OpenAI (<code>mockOpenAI()</code>), not the real one; the pictured code is in OpenAI's format.</sub></p>

## Install

```sh
npm install @byokit/accounts
```

[![npm](https://img.shields.io/npm/v/@byokit/accounts?style=flat&label=)](https://www.npmjs.com/package/@byokit/accounts) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=accounts-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

```sh
npm install @byokit/accounts
```

The whole ChatGPT flow, run against the stand-in OpenAI so it needs no account and no network beyond loopback: sign in
by device code, see the status, ask.

```ts
import { Accounts, portable } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';

const openai = await mockOpenAI(); // a stand-in OpenAI on 127.0.0.1, no account needed
const accounts = new Accounts(
  { authBase: openai.base, apiBase: openai.base }, // default store: in memory
  portable, // device code with fetch alone, as on a phone or in a browser
);

const shown = await accounts.login(1, 'chatgpt');
console.log(shown?.state, shown?.via, shown?.code);
openai.approve(shown!.code!); // the person types the code on the provider's page

await accounts.finished(1, 'chatgpt'); // the whole sign-in, once the code is approved
console.log((await accounts.status(1, 'chatgpt')).words);

const answer = await accounts.respond(1, { instructions: 'Answer briefly.', input: 'Plan my day', onText: (d) => process.stdout.write(d) });
console.log('\nfinal:', answer);
await openai.close();
```

```text
waiting code MOCK-10001
ChatGPT is connected.
You said: Plan my day
final: You said: Plan my day
```

The stand-in echoes the question. In an app, drop `authBase`, `apiBase` and `portable`, and give each person a store,
as below.

### On a computer

On a computer it uses Pi's [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) sign-in
flows, pinned exactly:

```ts
import type { SafeStorageLike } from '@byokit/accounts';
import { isolate, launchEnv } from '@byokit/accounts/isolate';
const dir = isolate('/path/to/app/engine'); // creates the folder; never changes process.env
const launch = launchEnv({ set: { PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1',
  PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' } });
// Pass launch.env to spawn(), or launch to Herdr's startAgent({ env: launch, ... }).

// Your Electron main process waits for app.whenReady(), then passes its safeStorage here.
export async function connect(safeStorage: SafeStorageLike) {
  const { Accounts, fileStore } = await import('@byokit/accounts');
  const accounts = new Accounts({ store: (member) => fileStore(`/path/to/app/people/${member}/auth.json`, safeStorage) });
  const shown = await accounts.login(1, 'chatgpt', { via: 'code' }); // { state: 'waiting', code, url }
  // show shown.code and shown.url; the sign-in finishes by itself
  return { shown, status: await accounts.status(1, 'chatgpt') };
}
```

### On a phone or in a browser

The same `Accounts` signs in by device code with `fetch` alone (Pi's flows need Node), into the phone's
secure storage or the browser's IndexedDB. The person approves the sign-in on their own phone; ChatGPT has its own
device flow, and every other provider joins from its catalogue `device` row (RFC 8628 device authorization, the
client id and endpoints its own pinned client uses):

```ts
import * as SecureStore from 'expo-secure-store';
import { fetch as streamingFetch } from 'expo/fetch'; // optional: React Native's fetch returns the answer at once
import { Accounts, secureStore } from '@byokit/accounts';

const accounts = new Accounts({ store: (member) => secureStore(SecureStore, `byokit.${member}`), fetch: streamingFetch as unknown as typeof fetch });
const shown = await accounts.login(1, 'chatgpt'); // { state: 'waiting', via: 'code', code, url }: open url, show code
```

Then ask ChatGPT with that sign-in, showing streamed pieces while it runs and the returned final answer when it
finishes (the completion can correct earlier pieces):

```ts
const answer = await accounts.respond(1, { instructions: 'Answer briefly.', input: 'Plan my day', onText: (d) => show(d) });
show(answer);
```

Examples: [`examples/expo`](../../examples/expo) (iOS and Android bundles; Android emulator sign-in, asking, pairing)
and [`examples/pwa`](../../examples/pwa) (browser sign-in).

## API at a glance

| Export | What it does |
|---|---|
| `Accounts` | Sign-in, status, sign-out, asking and limits for each member: `login`, `finished`, `status`, `plan`, `logout`, `respond`, `chatgpt`, `failed`, `ladder`, `keepFresh`; explicit custom servers: `endpoint`, `endpointReadiness`, `endpointRuntime` |
| `ENDPOINT_PRESETS`, `EndpointError`, `EndpointOptions`, `EndpointModel`, `EndpointDriver` | Local preset facts, typed readiness failures, public endpoint/model configuration and the same-device host driver seam |
| `portable`, `computer`, `loopback` | The platform `Accounts` runs on: device code with `fetch` alone, or (Node entry only) Pi's flows and the loopback listener |
| `memoryStore`, `fileStore`, `secureStore`, `browserStore`, `recordStore` | One store per person: in memory, a sealed 0600 file (Node entry only), Keychain/Keystore, IndexedDB, or your own load and save |
| `offered`, `provider`, `PROVIDERS` | The catalogue: each provider's billing, models and source |
| `billingWords`, `say`, `WORDS`, `signInError`, `failure`, `clock`, `callbackPage` | The plain sentences every app shows the same way (`words.json`), a time in words, and the page a browser sees after a sign-in |
| `respond`, `ResponseError`, `IncompleteError`, `sseReader`, `limitResponse`, `isFunctionCall` | Ask ChatGPT's answers endpoint with a sign-in, with tools, pictures, thinking effort and an answer shape; the error with the words to show and the kind acted on |
| `classifyFailure`, `classify`, `REST_MS` | An error's kind (limit, overload, plan without this use, lapsed sign-in, network) and default rest times |
| `planOf`, `claims` | The ChatGPT plan and email behind a sign-in, from its own token |
| `planLabel`, `claudeProfile` | A plan as a person says it ("ChatGPT Plus", "Claude Max"); the Claude plan and email from Claude's profile |
| `deviceStart`, `devicePoll`, `credentialOf`, `portableEngine`, `PORTABLE` | ChatGPT's own device-code flow, the sign-in built from a token answer, and the engine under `portable` |
| `deviceFlow`, `signable`, `signInChoices`, `DeviceFlow` | A provider's RFC 8628 device data from the catalogue, which providers this engine signs in to, and the picker rows a phone or browser offers |
| `isolate`, `launchEnv`, `INHERITED`, `emptyAuthContext` (`/isolate`) | Prepare app folders; copy and scrub child environments; ambient discovery off |
| `mockOpenAI`, `mockJwt`, `decoy`, `traceFs`, `CANARY` (`/testing`) | A stand-in OpenAI, and the decoy-HOME harness and fs tracer for isolation tests |

`computer`, `loopback` and `fileStore` come from the Node entry only; `isolate` and `/testing` need Node too.

## Which sign-in works where

| | Computer (Node, Electron main) | Browser (PWA, Electron renderer) | Phone (React Native: iOS, Android) |
|---|---|---|---|
| ChatGPT (subscription) | Its own page, straight back to this computer (port 1455); a code when asked or stuck | Device code | Device code |
| Claude Pro/Max (subscription) | Paste by default; explicit browser callback on port 53692 | Same PKCE flow, its token and profile requests through the app's own server | Same PKCE flow; app supplies Web Crypto |
| Anthropic (API key, billed per use) | App passes its own key, explicitly | Same fetch-only Messages provider | Same fetch-only Messages provider |
| OpenRouter (API billing) | Pi's browser callback or paste; explicit API selection and device-owned `keyStore` required | Not yet | Not yet |
| Radius (billing set by gateway) | Pi's browser callback (1456) or device code; explicit-only | Not yet | Not yet |
| Grok, Kimi | Pi's device flows; the same RFC 8628 flow from their catalogue `device` rows | Device code | Device code |
| Copilot, Meta | Pi's device flows; Copilot accepts an Enterprise domain | No | No |
| Where sign-ins are kept | `fileStore(path, safeStorage)`, sealing required | `browserStore(name)` (IndexedDB) | `secureStore(SecureStore, name)` (Keychain, Keystore) |

Device code works everywhere: OpenAI's sign-in endpoints answer any web page. The page-straight-back sign-in needs a
listener on the computer the browser runs on, so it is desktop only: ChatGPT sends the browser back to
`localhost:1455`, fixed for the client this signs in as. A web page can't call ChatGPT's model endpoint itself (it
doesn't answer other web pages), so a PWA's model calls go through the app's own server or relay.

## Catalogue and billing

`catalogue.json` holds each provider's billing (`subscription`, `api`), models, source, and RFC 8628 device data (`device`) where the provider offers it.
All subscription rows are offered by default on platforms that support their sign-in. API-billed rows
are offered only when the app names them. An explicit `offer` list is not platform-filtered.
The `Provider` shape no longer has `terms`, `hidden` or `why`, and `Terms` is no longer exported.
Qwen and MiniMax have subscription catalogue rows; their paste and portal sign-in flows follow in later work packages.
Each provider's own terms apply to how you use your plan.
`routes()` lists every pinned pi-ai provider and sign-in method, including unavailable rows with typed readiness, using D18 in [`docs/runtime-kits.md`](../../docs/runtime-kits.md#21-account-routes-d18). `offered({ platform })` returns ready subscription routes, including plan keys. The legacy `providers`/`offered()` calls keep their provider IDs; Qwen and MiniMax's unavailable plan flows are not defaults. Radius has `unknown` billing: it is visible in discovery but never offered or chosen automatically. Computer device fixtures do not qualify phone/browser device runtime.
Anthropic Messages uses an app-passed API key (billed per use); authentication is separate from the Messages request.

Native Claude CLI sign-in uses the managed-folder entry.
Approved exception: the `./cli` entry reads and runs only app-managed per-account folders under `stateDir` and the absolute CLI binaries the app passes; it never touches the person's default login; tokens never leave the device and are never logged.

```ts
import { Accounts, billingWords, offered } from '@byokit/accounts';

console.log(new Accounts().providers.map((p) => p.key)); // the default offer on a computer
for (const p of offered(['chatgpt', 'openrouter'])) console.log(`${p.name}: ${billingWords(p)}`);
```

```text
[ 'chatgpt', 'grok', 'copilot', 'claude', 'kimi', 'meta' ]
ChatGPT: Uses your ChatGPT plan.
OpenRouter: Charged per use to your OpenRouter account, not a plan.
```

## Key routes

Every `key` and `plan_key` route uses the same `add`, `saveKey`, `list`, `status`, `logout` and `remove` path.
Name the route ID to select its exact method/region; `add(member, provider, { via: 'key' | 'plan_key', key })`
also selects the first matching named provider route. Keys go only to the member's supplied `@byokit/secrets`
`keyStore`. The credential record holds a non-secret marker; `.accounts.accounts` holds route/billing metadata.
No environment, other program's login, default CLI account or credential file is consulted.

See the [typed key-route example](#typed-key-route-example) below.

On a computer `computer` already answers key routes. In browsers and React Native the main entry stays free of
the adapters and vendor SDKs, so opt in with the separate entry: `import { withKeys } from '@byokit/accounts/keys'`
then `new Accounts(options, withKeys(portable))`. Adding, saving, listing and signing out keys need no entry;
without it, answering a key route fails with `KeyRouteError.code === 'needs_keys'` before any secret is read.
The adapters still load lazily on the first key request.

`respondKey` (or the `respond` overload above) accepts the full typed pinned Pi `Model`, `Context` and
`ModelsApiStreamOptions`, returning its `AssistantMessage` with usage and tool/thinking content.
`onText` receives text deltas; `onEvent` receives sanitized Pi stream events. The model's provider must match
the selected route's upstream ID. App-supplied model/endpoint metadata is required; nothing guesses a model.
The selected member/account never changes during the request. Saved auth overrides `apiKey` and these
credential headers (case-insensitive, in both model and options): `authorization`, `x-api-key`, `api-key`,
`x-goog-api-key`, `cf-aig-authorization`. Non-auth headers, hooks, model metadata and typed sampling/tool
options pass through; the guard disables header-auth transforms, retries and provider/model fallbacks.
Cloudflare Gateway uses its pinned `cf-aig-authorization`-only auth; pasted Anthropic bearer uses only
`authorization`, never an API key header.

An explicit prebuilt SDK `client` is refused with `KeyRouteError.code === 'auth_override'` **before** opening
saved-account secrets: its opaque authentication cannot be verified as this account. It is not silently
ignored or relabelled. For explicit native/client-owned authentication, `keys()` from `@byokit/accounts/keys`
(also `computer.keys()` on Node) exposes the unmodified typed Pi factories and adapters, including complete `Models`
stream/complete/simple/deferred operations and stock options/hooks. Supply an explicit app-owned auth
context (required on Metro), register your own provider and own that authentication/billing; do not
attribute native/client-owned requests to a saved account. The selected-key helper is not a restriction
on the native Pi API or a mobile-readiness downgrade. Errors expose only bounded words
and a `KeyRouteError.code`; they never echo vendor bodies or key-store failures.

Plan keys keep subscription billing and are eligible for Auto; API/free/local/unknown billing is never an
Auto or Default **fallback**. A deliberately saved API default remains an explicit selection. `saveKey` retains
its `billedPerUse: true` requirement for API routes; a plan key needs no per-use consent. Token-paste variants
are separately labelled: the Claude plan token and Copilot plan token do not change into API keys.
Generic Anthropic bearer tokens keep unknown billing; the kit does not infer a plan from an arbitrary token.

Fetch-compatible adapters run on Node, browsers and React Native; browser CORS still belongs to the host.
Azure, Vertex and Cloudflare routes are Node-only at the pin and reject on portable platforms before keys
are read. Azure/Cloudflare endpoint/config values are explicit model/options inputs (cloud metadata helpers
are separate). Google uses the platform’s global `fetch`: the kit does not inject `AccountsOptions.fetch`
(including Expo’s streaming fetch) for Google or Node Vertex. Explicit `ask.options.fetch` still has the
pinned adapter’s refusal when it differs from `globalThis.fetch`. Google streaming on a phone depends on
that host’s global fetch; mock/Metro qualification is not a device-streaming claim.
Bedrock key storage works on Node, but inference reports `needs_host` before credentials: the pinned adapter
reads ambient AWS profile state even with a bearer token, so only an isolated cloud-host adapter may use it.
An absent plan flow reports `no_upstream_flow`, never a fabricated successful login. These are source/mock
qualification claims, not live vendor sign-in claims.

## Sign-in

On computers, the provider's own page by default. For ChatGPT, whose page returns to this computer's port 1455, the
kit listens there itself, so the tab shows your app's words (`new Accounts({ app: 'My App' })`) and only once they are
true. A code takes over when asked ("Having trouble?"), when the page never comes back, or when the port is taken by
another sign-in.

A 15-minute cap, nothing kept unless the engine can use it, and every failure is one plain sentence (`words.json`)
with a `why` for apps that word it themselves. `plan(member)` tells a work ChatGPT from a personal one; `plan(member, 'claude')` names the Claude plan (read once per
sign-in from Claude's profile, an empty plan when it doesn't say), and `planLabel(name, plan.plan)` says either as "ChatGPT Plus" or "Claude Max".

## Sign-out

`logout(member, key)` attempts to revoke a ChatGPT token at OpenAI (`POST auth.openai.com/oauth/revoke`), then deletes
the local sign-in even if the revoke fails. A failed revoke rejects after local deletion; report it because the remote
sign-in may remain active.

Within one store instance, a refresh already in progress finishes first, so sign-out uses its rotated token. If a
cancelled sign-in finishes late, `onSignOutError` reports a failed revoke of its discarded credential (or a generic failure is logged
when no handler is set).

## One person, one store

`memoryStore()`, `fileStore(path, safeStorage)` (sealed, 0600), `secureStore(SecureStore, name,
options?)` or `browserStore(name)`; any other storage with `recordStore(load, save)`. Writes are serialized within a
store instance; `fileStore` also serializes across processes through a `<path>.lock` file beside it, and
`browserStore` uses Web Locks across tabs for the whole record when available. Never a shared
fallback.

### Refresh safety

`portableEngine` (the default on phones and in browsers) holds the store lock, re-reads the current sign-in, and saves
a non-secret `byokitRefresh` generation/attempt marker in the credential record **before** sending a refresh grant.
It commits the replacement pair before returning access. A lost response, terminal refusal, unchanged refresh grant,
or failure to save the replacement requires sign-in again; an attempted or quarantined generation is never retried,
including by `recheck`. If the attempt marker cannot be saved, nothing is sent. A fresh sign-in replaces quarantine.
This deliberately requires sign-in again after even a network failure once a refresh send has started: the server
may already have spent the grant. Storage failures before the send, such as a locked phone keychain, remain retryable.

- **iOS/Android `secureStore`**: crash-safe across process restart after the platform acknowledges the marker write,
  with one store instance/refresh owner per storage name. Its chunk-generation pointer commits the marker and each
  replacement atomically. Multiple app processes or independently created store instances need a host lock covering
  the whole transaction.
- **Browser/PWA `browserStore`**: IndexedDB commits the marker before sending. With Web Locks it serializes the whole
  transaction across tabs. Without Web Locks, use one store instance and tab; multiple writers are only best-effort.
  Browser storage eviction, rollback and power-loss durability are outside this guarantee.
- **Node/Electron `fileStore` with `portableEngine`**: the sealed file is atomically replaced and synced when Node
  permissions permit; on POSIX the directory is synced too. Process restart retains the attempt. A `<path>.lock` file
  beside it serializes the whole transaction across processes; a dead holder's lock is removed. On Windows or with Node's permission model, power-loss durability is best-effort.
- **`recordStore(load, save)`**: crash safety depends on the host's atomic, durable save completing before its promise
  resolves and a host lock across independent writers. A best-effort save makes refresh best-effort too.
- **`memoryStore`**: serialized only in memory; there is no restart recovery. A bare custom `CredentialStore` can serve
  existing access but cannot refresh: wrap its durable load/save in `recordStore`, or implement the exported
  `RefreshStore.refresh` transaction contract with these same guarantees.

The default computer engine is still Pi's engine; its refresh path does **not** use this transaction. Other engines
and runtime aggregators own their own refresh guarantees. The fix does not add a second refresher to them.

The persisted-attempt, failed-save and concurrency regression ideas were informed by
[clauth's refresh guard](https://github.com/uwuclxdy/clauth/blob/6410345c65b91cf07eabd4f9f79670ba602ace63/src/codex_auth.rs).
The TypeScript transaction and synthetic tests were written independently; no upstream code or tests were copied.

- **Browser**: browser storage is readable by scripts on your page: avoid untrusted scripts.
- **Phone**: pass `{ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }` as `options` (to every get, set
  and delete) so tokens never migrate to a new device through an iCloud/iTunes backup; without it Expo's default
  (`WHEN_UNLOCKED`) applies.
- **Reinstall**: iOS Keychain items survive an app reinstall under the same bundle id (Android data is gone). Apps that
  must forget on reinstall keep a first-run marker outside the Keychain (e.g. `expo-file-system` or `AsyncStorage`)
  and, when it is missing, call `accounts.logout(member, key)` for each offered key before first use, which revokes and
  wipes.
- **Another engine**: using another engine with the same seam (Pi's coding-agent `ModelRuntime`)? Override
  `open(member)` with an engine whose `credentialStore` is made with `boundStore(member, engineStore)` and whose
  `readCredential(id)` reads that store.

```ts
const accounts = new Accounts({
  store: (member) => secureStore(SecureStore, `byokit.${member}`, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
});
```

## Asking

`respond(member, { instructions, input, model?, onText?, signal? })` asks ChatGPT's own answers endpoint with the
member's sign-in, refreshed first when due, and returns the whole text (`onText` gets each piece as it streams; the
returned completion is authoritative). Pass `result: true` to receive `{ text, output, usage? }` even without tools.
`usage` retains provider-reported `input_tokens`, `output_tokens` and native details in the same shape as the
Messages route; absent usage stays absent. Subscription token counts do not imply an API-key charge.
A limit or a lapsed sign-in is acted on as `failed()` does, then thrown as a
`ResponseError` with the words to show and the kind acted on. Rules: [conformance fixtures](../../fixtures/README.md).

A cut-off answer always throws `IncompleteError` (a `ResponseError` with `kind: null`), with or without tools.
Its `reason` preserves the provider's `incomplete_details.reason`, including `max_output_tokens` and
`content_filter` (`unknown` when absent). Its `result` holds the partial `{ text, output, usage? }` for apps that want to
show it as unfinished. `onEvent` also receives `{ type: 'incomplete', reason }` before rejection; `onText` may
already have shown partial words. This covers `response.incomplete` events and `status: 'incomplete'` envelopes,
whether fetch streams SSE, buffers it, or returns JSON. The account stays signed in and is not put to rest.
Successful return values are unchanged.

Set `parallelToolCalls: false` to request one tool call at a time; `true` allows parallel calls. Both pass through as
`parallel_tool_calls`; omitting it sends nothing and keeps the provider default. `respond` supports only the ChatGPT
subscription route; OpenRouter, Grok and Copilot are credential routes without `respond` support, and there is no
Anthropic response route.

The whole question passes through: `input` takes the turns so far (messages, with `input_image` where the person
attached a picture), `tools` and `tool_choice` take the app's own function tools and built-ins (including
`image_generation`), `reasoning.effort` how hard the model thinks, and `text` how long the answer is with the shape it
must follow (`text.format`). With `tools` the result is the text with every output item; without, the plain text as
before. `onEvent` sees each tool call and output item as it streams:

```ts
const result = await accounts.respond(1, {
  instructions: 'Answer briefly.',
  input: 'What time is it in Norwich?',
  tools: [{ type: 'function', name: 'get_time', description: 'The time somewhere.', parameters: { type: 'object', properties: { place: { type: 'string' } } } }],
  onEvent: (e) => { if (e.type === 'function_call') console.log('calling', e.name, e.arguments); },
});
if (isFunctionCall(result.output[0])) {
  const answer = await accounts.respond(1, {
    instructions: 'Answer briefly.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'What time is it in Norwich?' }] },
      result.output[0],
      { type: 'function_call_output', call_id: result.output[0].call_id!, output: 'noon' },
    ],
  });
  show(answer); // 'You did: noon' against the stand-in; the model's own sentence live
}
```

A web page can't call this endpoint itself (it answers no other web page): ask from the app's own server or over
`@byokit/link`.

## Limits

`failed(member, key, error)` rests an account until the provider said (or a default), marks a plan that doesn't
include this use, and signs out only a sign-in that no longer refreshes. `ladder()` picks the next usable account;
`keepFresh()` refreshes ahead of expiry. Limits come from errors only; no undocumented usage endpoint is read.

## Isolation

Ambient discovery is off (no environment variable or credential file is ever consulted), and
`@byokit/accounts/testing` has the decoy-HOME harness and fs tracer to prove it in your own tests. `decoy(root)` writes
only under the caller-supplied root; the caller owns its creation and cleanup.

## A stand-in OpenAI

`mockOpenAI()` from `@byokit/accounts/testing` (or, from a repo checkout, `node packages/accounts/src/testing/mock-openai.ts [port]`) answers device code, its
page where a person types the code, token exchange, refresh, revoke and streamed answers (echoing the question), so
tests and demos sign in and ask end to end with no account. Point the kit at it with
`new Accounts({ authBase, apiBase })`, as the [Quickstart](#quickstart) does.

`mockDevice()` stands in for any provider the catalogue gives device data: the code, the page that approves it,
polling and refresh on that provider's own documented endpoints. Point the kit at it with
`new Accounts({ deviceBase })`.

## Links

- [byokit](../../README.md): every package and example
- [`examples/pwa`](../../examples/pwa) (browser sign-in) and [`examples/expo`](../../examples/expo) (React Native, iOS
  and Android)
- [Conformance fixtures](../../fixtures/README.md)
- [CHANGELOG](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).

## ChatGPT subscription handles

After `Accounts.login(member, 'chatgpt')` finishes, `accounts.chatgpt(member)` returns a member-bound
subscription handle for `openai({ auth: 'account', account: handle, model })` in `@byokit/decide`.
It routes requests through `Accounts.respond`, which keeps tokens in the app's store and refreshes them
before use. The handle contains no credentials, follows sign-out, and needs no additional sign-in or
API key (billed per use). ChatGPT remains offered by default. Use the handle only where the sign-in lives.

## Official ChatGPT plan token-sharing adapter

`chatgptPlan({ session })`, also exported from `@byokit/accounts/chatgpt-plan`, binds a single person's
validated [official token-sharing session](https://developers.openai.com/siwc/token-sharing-open-source) to a
consumer such as `@byokit/decide`. `session(signal)` returns `{ accessToken, scopes }` after the host's own
sign-in integration validates identity and refreshes tokens. The adapter checks `resource.invoke` and
`chatgpt.tokens.use.direct` on every access; missing consent throws `UnsupportedAccountError` with
`code: 'unsupported_account'`. Billing is `subscription`, with no API-key fallback.

The host follows [official registration/sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
including ID-token signature/issuer/audience/nonce verification and protected per-person storage. Plan usage is
available to eligible open-source/local apps; paid/remote apps require approval. This adapter does not start an
OAuth flow and does not convert the existing Codex `Accounts.login()` credential into a token-sharing session.
It reads no environment or files, and remains portable to browsers and React Native.


## Desktop credential storage security

`fileStore(path, safeStorage)` requires a sealing adapter; there is no plaintext fallback.
In Electron, pass `safeStorage` after `app.whenReady()`. The store refuses unavailable encryption
and the Linux `basic_text` backend. Other adapters must protect their keys outside the credential
file and provide authenticated encryption. For a Node service, use a host-owned keystore through
`recordStore(load, save)`, or provide an equivalent sealing adapter; the kit never discovers a key
or invokes an OS keyring itself. Use `memoryStore()` for temporary sign-ins.
If the adapter exposes optional `upgrade(bytes)`, a read validates the decrypted record, verifies
that upgraded ciphertext decrypts to identical text and atomically replaces the original. This
supports opt-in dual-wrap migration through `@byokit/secrets`; a failed replacement leaves the
original envelope usable. Hold the host writer lock for read upgrades as well as ordinary writes.

Use an app-owned directory: the immediate folder must be a real 0700 directory and credential
files must be private regular files. Processes writing the same file take turns through a `<path>.lock`
file beside it. See [SECURITY.md](SECURITY.md) for the threat model and limits.

**Migration from 0.7.x and earlier:** `fileStore(path)` is no longer accepted. Existing files already
sealed with the same adapter remain readable. Plain JSON is never silently imported or overwritten.
For a plaintext store, stop all writers, revoke the old credentials using the old app's sign-out flow,
remove the old app-owned credential file, and sign in again with a sealing adapter. Old plaintext
backups may retain tokens: delete them under the host's retention policy and revoke the affected
credentials. Do not point this migration at another tool's sign-in directory.
`classifyFailure(error, nowMs?)` returns a typed `Failure` (`{ kind, until }`) or `null`
for an unrecognized error. `until` is epoch milliseconds when the error says "try again
in N min/hours", and zero otherwise. For resting kinds, use
`failure.until || nowMs + REST_MS[failure.kind]`; signed-out, not-included and network
failures have no fallback rest. `classify` remains an alias. Pass a clock for deterministic
classification; the default uses `Date.now()`. It stores and logs no error text.

For a capability running where the sign-in lives, `await accounts.access(member, signal)` returns fresh `{ access, accountId }` from the app’s own ChatGPT store. Keep these credentials in that process; proxy signaling or relay media for another device. This uses the same refresh and signed-out behavior as `respond`.

## Anthropic Messages: API key (billed per use)

This route is never a default or a subscription fallback. The app supplies the key and an explicit model.
The kit never reads keys from environment variables, files or another tool's sign-in.

```ts
import { anthropic, AnthropicIncompleteError } from '@byokit/accounts';

export async function askClaude(appKey: string, show: (text: string) => void) {
  const claude = anthropic({ key: appKey });
  try {
    const answer = await claude.respond({
      model: 'claude-opus-5-5', max_tokens: 1024,
      system: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }],
      result: true, onText: (delta) => show(delta),
    });
    // answer.text, answer.output, answer.usage, answer.raw
  } catch (error) {
    if (error instanceof AnthropicIncompleteError) {
      show(error.reason); // error.result carries partial text/output, usage and native raw response
    } else throw error;
  }
}
```

Native `system`, `messages` (images, thinking, tool calls/results), `tools`, `tool_choice`, `thinking`,
`max_tokens`, `stop_sequences`, `metadata`, sampling and `output_config` pass through unchanged.
`onEvent` carries text deltas, tool JSON deltas, completed tools/content blocks, message events and an
incomplete event for `max_tokens` or `refusal`. A stream without `message_stop` fails. With `tools` or
`result: true`, the result carries metadata; without either, it returns text. Incomplete answers always
throw the shared `IncompleteError` contract (the `AnthropicIncompleteError` subtype retains typed native
metadata), including with tools or `result: true`. Call `isFunctionCall` on normalized `output` items; use native `raw.content` for the next Messages turn.

The catalogue's `label` is exactly `API key (billed per use)`; show it when presenting the explicit key route.
`billingWords` also supplies the existing plain sentence about per-use charges.

An `Accounts` instance can also use this route, with `offer: ['anthropic']` and
`accounts.respond(member, { provider: 'anthropic', key: appKey, model, max_tokens, messages, result: true })`.
The key is used for that request, never stored by the kit; `login` does not launch a plan flow for this route.

The existing `@byokit/decide` seam accepts it without a new dependency:

```ts
import { anthropic } from '@byokit/accounts';
import { answerer } from '@byokit/decide';

export function claudeBackend(appKey: string) {
  const claude = anthropic({ key: appKey });
  return answerer({ name: 'anthropic', leaves: true,
    ask: (prompt, signal) => claude.respond({
      model: 'claude-opus-5-5', max_tokens: 2048, signal,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
}
```

An incomplete answer throws through this text seam, so decide abstains rather than parsing a partial answer.
Browser apps should keep the API key in an app-owned server proxy (`base`); React Native can pass a streaming
fetch such as Expo's. `betas` explicitly opts into native beta headers.

## Claude Pro/Max subscription

Claude is available by default. Open its page, then paste the returned `code#state` into the app:

```ts
import { Accounts, memoryStore } from '@byokit/accounts';

const member = 1;
const credentials = memoryStore(); // replace with device-owned persistent storage in your app
const accounts = new Accounts({ store: () => credentials });
const pastedCode = 'code#state'; // collect the actual returned value from the person
const pending = await accounts.login(member, 'claude');
// Open pending.url in the person's browser, then collect the code from that page.
accounts.paste(member, 'claude', pastedCode);
await accounts.finished(member, 'claude');
const text = await accounts.respond(member, {
  provider: 'claude', model: 'claude-opus-5-5', max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

The manual HTTPS callback works without a local listener or an installed CLI. It uses PKCE (secure random verifier,
SHA-256 challenge), independent state, strict `code#state` validation, and direct JSON exchange/refresh at
`platform.claude.com/v1/oauth/token`. Refresh is single-flight for one store, saves an attempt before sending and commits the rotated credentials before
returning access. An omitted replacement requires sign-in again. `ClaudePlanExpiredError` means sign in again, including after a refused or uncertain rotation or a
failed durable save; a persisted attempt prevents replay after restart. A custom store must provide the refresh transaction seam (use
`recordStore(load, save)`); a host lock is required for multiple processes. Local logout removes only this app's credentials; it does not promise server
revocation. A Messages authentication refusal requests re-authentication without replaying the request or switching
billing to an API key.

Tokens belong in one device-owned `CredentialStore` per member. `keystoreStore(hostKeystore, 'member.1')` adapts
`@byokit/secrets` without importing Node into the portable entry. Electron can pass safeStorage to `fileStore`;
its sealed file writes atomically with mode 0600; a sealing adapter is required. Processes sharing one file take turns through a `<path>.lock` file beside it (see Refresh safety).
Phones use `secureStore` with device-only accessibility. PWA `browserStore` uses IndexedDB and Web Locks; page
scripts can read its credentials. Tokens are never collected by a BYOKit server or logged. The default is memory-only.

React Native hosts pass `claudePlan: { crypto: webCrypto }` when global Web Crypto is unavailable;
`ClaudePlanPlatformError` reports missing secure randomness/SHA-256. Claude's token and profile endpoints don't answer
other web pages, so a browser app passes a `fetch` that sends them through its own server, which passes each request on
unchanged and keeps nothing (`examples/pwa/serve.ts`); the kit never picks a proxy by itself. Tests replay protocol-shaped captures offline; no live OAuth, CORS, or current inference
compatibility is claimed. This implementation supplies the manual-flow headers and Claude Code identity prelude,
without relying on Pi's provider or executing an installed Claude CLI.

Protocol references: [Hermes credentials at 57a22675, PKCE/exchange](https://github.com/NousResearch/hermes-agent/blob/57a22675ef9f7761111feba9d24e5c366db3134b/agent/anthropic_credentials.py#L747),
[Hermes headers/identity](https://github.com/NousResearch/hermes-agent/blob/57a22675ef9f7761111feba9d24e5c366db3134b/agent/anthropic_adapter.py#L219),
[oh-my-pi auth rule at 2b023d1b](https://github.com/can1357/oh-my-pi/blob/2b023d1b80133c523d66412602d99b5427408395/packages/catalog/src/compat/rules/auth/anthropic.kdl#L1),
and [oh-my-pi refresh](https://github.com/can1357/oh-my-pi/blob/2b023d1b80133c523d66412602d99b5427408395/packages/ai/src/registry/engine/refresh.ts#L62).
The common route follows Hermes's platform token host, three scopes and `axios/1.7.9` token User-Agent,
with inference `claude-code/2.1.74 (external, cli)`, `x-app: cli`, bearer authorization, Messages version
`2023-06-01` and betas `claude-code-20250219,oauth-2025-04-20`. The implementation is independent;
[NOTICE](NOTICE) records the MIT protocol references.

## Choosing between accounts

The portable entry exports `chooseAccount`, `resolveSelection`, `roomOf`, `roomWords` and the structural
`AccountLike`, `AccountPick`, `Room`, `Considered`, `RunSelection` and `Defaults` types. The host supplies its own
account records and readings; these functions never read credentials, sign in, refresh, start a run or switch a
running conversation. Resolve once before starting and keep the selected account for the whole run.

```ts
import { resolveSelection, roomOf, type AccountLike, type Defaults } from '@byokit/accounts';

// Host-provided account, model and measurement accessors:
declare const accounts: readonly AccountLike[];
declare const defaults: Defaults;
declare function windowsFor(account: AccountLike, demand: readonly string[]):
  { usedPercent: number; kind: string; resetsAt?: number }[];
declare function measuredAt(account: AccountLike): number | undefined;
declare function modelsFor(account: AccountLike): { id: string; available: boolean }[];
declare function startRunWith(account: AccountLike, model: string): void;

const pick = resolveSelection(accounts, defaults, { account: 'auto', needs: ['provider/model'] },
  (account, demand) => roomOf(windowsFor(account, demand), measuredAt(account), 'milliseconds'), Date.now(),
  (account) => modelsFor(account));
if (pick.ok) startRunWith(pick.account, pick.model);
```

Auto uses ready subscription accounts (including a rest whose deadline has elapsed). It ranks usable readings
by most room, earlier refill, then list order; unknown readings follow; exhausted accounts refill first. A reading
older than 24 hours counts as unknown. A numeric reading without a measurement time retains its room tier,
with unknown age/confidence. Explicit account ids bypass state and billing filtering: the host must verify the
selected account is ready before starting, and a failed explicit selection never falls back to another account.
API key accounts (billed per use) are used only when explicitly selected by id or a ready default.

`sel.model` and deduplicated `sel.needs` form the demand passed to the room reader. Supply `models` to verify
every demanded model is available. Without it, the host owns model eligibility; `model` is the explicit or default
model, or an empty string when neither is provided. With a model list, no available model returns `not_included`.
Without a demand, selection stays within the default account's provider, or the first provider in list order.

Each pick includes every account's `considered` row in list order. It holds only ids, exclusion/ranking codes,
room figures, measurement age and confidence (`known`, `stale`, `unknown`); no names, emails, credential fields
or engine messages are copied. The winning row's `reason` is the pick's `why`; other candidate reasons describe
the deterministic comparison to the Auto winner. Excluded rows carry their first exclusion code. Account ids
and model ids supplied by the host must themselves be secret-free. The generic returned `account` is the original
host record: keep credentials outside that record before exposing the whole pick to UI or logs.

`AccountLike.until`, `nowMs`, `Room.at`, `Room.resetsAt` and `Considered.age` use **milliseconds**.
`roomOf(windows, at, resetUnit?)` accepts structural windows. Legacy reset **epoch seconds** are the default,
converted by 1000 exactly once. For normalized `@byokit/usage` 0.2.0+ windows, pass `'milliseconds'` as the
third argument; reset times then stay unchanged. A normalized usage `Room` also passes directly to the chooser.
The optional `at` is always the original measurement time in epoch milliseconds.
The current structural input contains `usedPercent`, `kind`, and optional `resetsAt`; hard-limit/model-scope and
poll-health ingestion is a follow-up to the pending usage extension. Hosts must supply demand-filtered windows
and authoritative eligibility rather than interpreting an unavailable quota reading as a fresh successful read.

`Provider.multiAccount` gives a terms assessment, reason and source for multiple accounts of that service.
A grey assessment records missing explicit documentation; it does not gate selection. `auto.terms`, `auto.*`,
`room.*` and `pick.*` words are exported in `WORDS`.

Identity and re-authentication stay with the host's canonical device store or engine. A provider account id
scoped by member/provider proves identity; names and emails do not. The TypeScript identity fixture records
wrong-account, duplicate identity, changed-email, absent-identity, removal/refresh and extension-field boundaries
for runtime integration; the chooser consumes host-validated state and never adopts credentials itself.

## Managed CLI accounts (Node only)

`@byokit/accounts/cli` exports `cliAccounts`, `CliAccountError`, `CliProvider`, `PiProvider`, `CliAccount`, `CliOptions` and `SignInCommand`. Accounts use subscription billing. The portable entries and the `Accounts` class retain their existing sign-in flows.

`CliAccount` extends the portable chooser's `AccountLike`. Pass normalized usage through `@byokit/usage`'s `roomOf(reading, nowMs)` when selecting an account, preserving millisecond reset times and the original measurement time.

```ts
import { cliAccounts } from '@byokit/accounts/cli';
const accounts = cliAccounts({
  stateDir: '/app/state/plans',
  bins: { claude: '/app/bin/claude', codex: '/app/bin/codex' },
  env: { HOME: '/app/home', PATH: '/app/bin:/usr/bin:/bin' },
  historyFrom: { claude: '/app/history/projects', codex: '/app/history/sessions' },
  prepare: async (folder, provider) => { /* app-owned setup, such as installing hooks */ },
});
const { account, signIn } = await accounts.add('claude');
// Run signIn.shell in the app's sign-in tab, or run signIn.argv with signIn.env
// and create signIn.completion privately only after that command succeeds.
const current = await accounts.status(account.id);
const { set, unset } = accounts.launchEnv(account.id);
// Apply unset to the launch environment, then apply set, before starting the agent.
```

`stateDir` must be an absolute app-owned directory with an existing parent. The kit creates it at 0700 and creates private `<provider>/<hex>` account folders below it. `bins` are absolute paths; PATH is never used to find the CLI. Status and login use an environment built from nothing plus the app's `env`, after removing provider credential overrides and adding the managed-folder variable. Pass proxy or temporary-directory settings explicitly if needed. `launchEnv` returns the folder variable in `set` and the provider overrides in `unset`; hosts must apply both so a stray API key (billed per use) cannot override the chosen subscription.

`add` returns a `signing` account and the native login command. For Claude/Codex, `status` stays `signing` until the completion marker exists, including after a host restart, and does not run a second native client during pending sign-in. Pi uses an auth-check probe instead (below). The shell uses a private per-folder lock and marks completion only after successful login. Stop the app's sign-in tab before `cancel` or `remove`; the kit does not supervise that tab. `signInAgain` reuses a pending command or starts a new completion cycle; if an account operation is already in flight it throws `prepare-failed`, so await that operation before retrying. Native CLIs own their refresh transactions; the kit neither copies credentials nor refreshes grants. A crashed sign-in shell can leave its lock; the host should stop that process and remove only that managed lock before retrying.

`list` probes managed folders concurrently; `status`, `rename`, `remove` and `cancel` serialize operations per account. Only signed-in state (`ready` or `signed_out`), email and plan come from native status output; no credential file is opened and raw CLI errors and output are discarded. `rename` accepts a trimmed name of 1–64 characters. `cancel` removes only folders added by this instance; for existing accounts it ends the pending completion cycle without deleting the account. `remove` deletes only a validated managed folder. `historyFrom` creates a history symlink inside that folder; it never creates or writes the target, even when it is missing. A throwing `prepare` rolls back the new folder.

Native status reads resolve within 15 seconds. Claude stdout is capped at 256 KB and identity JSON at 64 KB; the shared Codex client caps stdout at 64 KB. Timeout or excess output terminates only that owned child, with SIGTERM followed by SIGKILL after one second if it is still alive.

If the host does not supply a provider executable, its managed rows remain visible as `not_included`; list and Auto continue for the other providers. No identity probe runs and pending markers remain intact. Connect/reconnect and usage for that provider still require its explicitly supplied executable.

The existing `accounts-v1.json` `{version:1,accounts:[{id,provider,name,folder,found}]}` and `auto-terms-v1.json` `{acknowledged:true}` encodings remain unchanged, with 0600 files and atomic replacement. The kit preserves but excludes `found-*` and `found:true` rows, which belong to the host's default-login adapter. Legacy managed rows without kit completion sidecars retain their native signed-in status; new or re-signing rows require the completion marker. Symlinked account folders and records outside the provider/hex layout are refused.

`usageSource(id)` returns a Codex Source for `@byokit/usage`; Claude returns `undefined`, and its usage Source is `{provider:'claude', folder:set.CLAUDE_CONFIG_DIR, headers}` in a usage reader whose `stateDir` is the same managed root. `kinds` serves only the matching native agent (`claude`, `codex` or `pi`). `resumeArgs` accepts an `id` conversation reference for these kinds and also a `path` for Pi; `launchArgs(id)` supplies Pi's selected `--provider` and is empty for Claude/Codex. `termsAcknowledged` and `acknowledgeTerms` keep the host's existing terms bit; they do not gate sign-in. `suggestName` uses the first part of an email, falling back to the provider's name.

`launchEnv({ base?, account?, set?, unset? })` copies `base` (default: `process.env`), removes
provider namespaces derived from the catalogue and inherited API keys, then applies account settings
and explicit settings. Explicit unsets win. `account` accepts `{ set, unset? }`, including the result
of `cliAccounts.launchEnv(id)`. PATH, HOME and locale remain unless explicitly unset. The result
`{ env, unset }` lists removed names for shells which already inherited them. An explicit `set` is
a host opt-in; never put its credential values in terminal commands or logs. `isolate(dir)` retains
its directory return value but no longer changes global environment variables.

### Native Pi and found-row boundaries

Managed Pi accounts require stock published Pi 0.87.1 and an explicit subscription OAuth provider: `openai-codex`, `anthropic`, `github-copilot`, `xai`, `kimi-coding` or `meta`. Unsupported providers are refused; Claude subscription routes must be offered only where the provider's terms allow their use.

```ts
import { cliAccounts } from '@byokit/accounts/cli';

const plans = cliAccounts({
  stateDir: '/app/state/plans', bins: { pi: '/app/bin/pi' },
  env: { HOME: '/app/home', PATH: '/usr/bin:/bin', TMPDIR: '/app/tmp' },
});
const { account, signIn } = await plans.add('pi', { piProvider: 'openai-codex' });
// Run signIn.shell in the app's sign-in tab (or argv with env).
// Display signIn.instruction: the person types /login openai-codex in Pi's TUI.
// NEVER pass /login as an initial message: Pi would send it to the model.
const current = await plans.status(account.id);
const launch = plans.launchEnv(account.id); // PI_CODING_AGENT_DIR; unset other CLI/session folders
const providerArgs = plans.launchArgs(account.id); // ['--provider', 'openai-codex']
```

Pi login argv is just `[bin]`; closing its TUI does not create a completion marker. `status` runs only the selected managed folder's `auth check --provider <id> --json --no-refresh`, never `--credentials`. Only `ready` + `authType: oauth` qualifies as subscription-ready and clears pending. `not_ready` stays `signing` while pending, otherwise `signed_out`; an API key returns `signed_out` with `why: api_key`. Invalid, malformed, timed-out or oversized output returns `signed_out` with `why: unknown`. Output is capped at 64 KB and raw errors/credentials are discarded. **No-refresh does not check OAuth expiry**: stored expired OAuth can appear ready; native Pi owns refresh on use, so readiness is not a promise that the next request succeeds.

The kit never opens/seeds/copies Pi's `auth.json`, `settings.json` or `models.json`; Pi itself reads only its selected folder. Pi rows persist separately in `pi-accounts-v1.json`, so older Claude/Codex kit writes cannot delete them. Their named identity is `id`, `name`, `piProvider` and the folder, not an inferred email or plan. Email/plan and usage are unknown, and no email dedupe is attempted. Auto considers only confirmed `ready` rows; it never guesses a default identity, pools accounts, rotates them, or falls back to API billing.

Settings and sessions stay in the selected folder. Pi `--session <id>` resolves inside that folder; cross-account resume needs an explicit session path, or host-owned shared sessions via `historyFrom.pi`. Session `id`/`path` references are preserved unchanged.

`nativePiAccount` remains a **read-only launch descriptor** for a separately owned Pi folder. It neither reads a grant nor claims sign-in state or identity:

```ts
import { nativePiAccount } from '@byokit/accounts/cli';
import { launchEnv } from '@byokit/accounts/isolate';

declare const appStateDir: string;
declare const ownedPiFolder: string; // existing <appStateDir>/pi/<hex>, never a default folder
declare const piBin: string; // app-supplied absolute binary
declare const appHome: string;
declare const sessionPath: string;
const pi = nativePiAccount({ stateDir: appStateDir, folder: ownedPiFolder, bin: piBin, home: appHome });
const childEnv = launchEnv({ base: { HOME: appHome, PATH: '/usr/bin:/bin' }, account: pi.launch }).env;
const argv = pi.resumeArgs({ kind: 'path', value: sessionPath });
// The host spawns pi.bin with argv and childEnv; native Pi owns its grants and session.
```

Pi uses its own `auth.json` in `PI_CODING_AGENT_DIR`; a Claude managed folder alone does **not** select the same account in Pi. Do not advertise `kinds('claude')` as including Pi, pass a Claude grant to Pi, or fall back to the person's default Pi folder. This contract has offline fixture coverage; it does not claim live login or native working-pane handoff qualification.

Found rows remain read-only host records. `signInAgain('found-*')` and managed launch operations still reject them with `unknown-account`. For an explicitly selected found row, call `adopt(foundId, { piProvider? })` (required on first Pi adoption). It reads only roster metadata, creates a **new empty managed folder**, and returns `{ account, signIn }`. Nothing reads, writes or copies the source/default login; the original row stays unchanged. The host maps the found selection to the returned managed `account.id` and may collapse the old row using `account.adoptedFrom`. Concurrent/repeated adoption reuses that managed identity and its sign-in cycle; unknown/non-found ids are refused. Stop the sign-in tab before cancellation: `cancel(newId)` removes the new row/folder in the creating instance, while after restart it only clears pending and retains the named identity. No implicit adoption happens through status or Auto.

## Scripted sign-in stand-in

`mockOpenAI({ answers })` from `@byokit/accounts/testing` runs the normal device-code sign-in and
ChatGPT response path on loopback. Each script has `{ match, text, usage? }`: a string matches a
substring of joined input text, a regex tests it, and a function receives it and returns a boolean.
The first match wins, including on repeat requests; unmatched input retains echo/tool behavior.
Replace `mock.state.answers` between requests to change scripts. Counts are explicit fake data.

```ts
import { mockOpenAI } from '@byokit/accounts/testing';

const mock = await mockOpenAI({ email: 'umer@example.com', answers: [
  { match: 'Umer', text: 'Ready.', usage: { input_tokens: 12, output_tokens: 3 } },
  { match: /finished/i, text: 'Done.' },
  { match: (prompt) => prompt.includes('help'), text: 'I can help.' },
] });
```

## Member API keys (billed per use)

Offer `openai`, `typesafe` (Jev), or `openrouter` explicitly. Show each catalogue
`label`: “API key (billed per use by OpenAI/TypeSafe/OpenRouter)”. Ask the member
to agree to per-use billing before calling `saveKey`. These routes never enter
`ladder`, even when a subscription is unavailable.

```ts
import { Accounts } from '@byokit/accounts';
import { fileStore } from '@byokit/secrets';
import { jev, openai } from '@byokit/decide';

// The host supplies these values; never hardcode real keys in source.
declare const dataFolder: string;
declare const passphrase: Uint8Array;
declare const enteredKey: string;
declare const chosenModel: string;
const accounts = new Accounts({
  offer: ['openai', 'typesafe', 'openrouter'],
  keyStore: (member) => fileStore({ path: `${dataFolder}/${member}.keys`, passphrase }),
});
// After Umer explicitly agrees to billing per use, pass the entered key:
await accounts.saveKey('Umer', 'typesafe', enteredKey, { billedPerUse: true });
const decisions = jev({ key: await accounts.key('Umer', 'typesafe') });
// After saving the corresponding keys with the same consent:
const routedDecisions = jev({ key: await accounts.key('Umer', 'openrouter'), via: 'openrouter' });
const generalDecisions = openai({ key: await accounts.key('Umer', 'openai'), model: chosenModel });
await accounts.logout('Umer', 'typesafe'); // deletes the saved key on this device
```

Use a fixed host-owned mapping from member ids to private paths; never use untrusted
member text as a filesystem path. `keyStore(member)` must refer to the same store
across calls and a separate namespace per member. On phones use secrets' `nativeStore`;
in browsers use `webStore` with a separate database per member. There is no default
key store or plaintext fallback. Keys stay in device storage and are handed only to
the selected provider's request on the host; never serialize `key()` into views,
snapshots, logs, or messages to another device. Status and connection results contain
no key, and storage failures have fixed, redacted messages.

OpenRouter's browser/paste authorization also creates a permanent API-billed key, so it requires
`keyStore` and explicit API selection (`billedPerUse: true`). The shared key persistence seam saves the
secret only in `keyStore`; the ordinary credential store/index keeps non-secret membership/route metadata.
Saving a key marks it connected locally; the selected provider checks validity on the first request.

### Computer sign-in methods

```ts
import { Accounts } from '@byokit/accounts';
import type { Keystore } from '@byokit/secrets';
// This example has one member; the app supplies that member's private device-owned store.
declare const memberKeys: Keystore;
declare const returnedRedirectUrl: string;
const accounts = new Accounts({
  offer: ['claude', 'openrouter', 'radius', 'copilot'], keyStore: () => memberKeys,
});
// Claude's existing paste route remains the default on every supported platform.
await accounts.login('Umer', 'claude');
// Explicit computer callback, through the pinned adapter (fixed registered port 53692).
await accounts.add('Umer', 'claude', { via: 'browser' });
// Offer OpenRouter explicitly and configure keyStore. This chooses API billing, not a plan.
const connected = await accounts.add('Umer', 'openrouter', { via: 'paste', billedPerUse: true });
accounts.paste('Umer', connected.id, returnedRedirectUrl);
// Offer Radius explicitly: its gateway sets billing; never inferred to be a subscription.
await accounts.add('Umer', 'radius', { via: 'code' });
await accounts.login('Umer', 'copilot', { enterpriseDomain: 'company.ghe.com' });
```

`SignInOptions` also accepts `fresh`; `login` and `add` share these options. Enterprise input is a
hostname, without URL credentials, ports or paths. Omit it (or pass blank) for github.com. The
pinned adapter owns polling, exchanges and Enterprise credential metadata. Missing host/platform
support is reported before credential access; this unit adds no phone/browser device runtime.
`runtime(member, id)` retains the engine's complete typed login/auth pass-through for app-owned
interactions. Never expose credentials from that host-only handle in a UI or another device.

### Several accounts per member

Built-in stores keep a non-secret account index alongside sealed credentials. Custom stores use `recordStore(load, save)` to supply the same transaction seam. New sign-ins are staged until they succeed:

```ts
import { Accounts } from '@byokit/accounts';

const accounts = new Accounts(); // in-memory store; pass your app's store to persist
const added = await accounts.add('Umer', 'chatgpt', { via: 'code' });
// Show added.signIn, then poll view('Umer', added.id) as with login.
await accounts.finished('Umer', added.id);
const id = accounts.view('Umer', added.id)?.id; // canonical id after identity dedupe
if (id) await accounts.rename('Umer', id, 'Work');
const rows = await accounts.list('Umer');
if (id) await accounts.setDefaults('Umer', { account: id });
```

A different identity adds a row; reconnecting the same identity replaces its credential and preserves its name and default. Failed additions leave existing accounts intact. `remove(member, id)` signs out only that row. Existing `login(member, provider)` selects that provider's default account, else its first. Status includes `id` and `provider`; hooks receive account ids. Host capabilities can call `runtime(member, id)` or `access(member, signal, id)` for a specific account. Tokens stay on the device and never enter list rows or the index. See [the WP1 contract](../../docs/accounts-multi.md).

## Custom endpoints and local runtimes

`endpoint(member, options)` stores one explicitly selected server for one member. `billing` is required:
`local`, `api`, `subscription` or `unknown`. A loopback address never determines billing: a local proxy can still
charge a remote API. Auto **and Default** refuse non-subscription rows, even when that row is the saved default;
using its exact account id is explicit selection. `list()` carries the selected billing and its plain label.

```ts
import { Accounts, ENDPOINT_PRESETS, type EndpointModel } from '@byokit/accounts';

const model: EndpointModel = {
  id: 'your-installed-model', name: 'My model', reasoning: false, input: ['text'],
  contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // host estimates, not billing evidence
};
const accounts = new Accounts(); // supply store(member) for durable metadata
const { id } = await accounts.endpoint(1, { ...ENDPOINT_PRESETS.ollama, models: [model] });
const runtime = await accounts.endpointRuntime(1, id);
const selected = runtime.getModel(id, model.id)!;
const answer = await runtime.completeSimple(selected, {
  messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
});
```

Presets are `ollama` (11434), `llama.cpp` (8080), `vllm` (8000), `lmstudio` (1234) and `sglang` (30000),
using their OpenAI-compatible `/v1` URLs. They say `local` because of the preset fact, not the address;
you can explicitly override both URL and billing. Custom `compat` is `openai` or `anthropic` (Pi's
`openai-completions` / `anthropic-messages` adapters); use the server's SDK base URL for that protocol.

Pass `key` only when explicitly selecting keyed authentication; it requires the member's owner-selected
`keyStore(member)` from `@byokit/secrets`. There is no plaintext, environment or CLI-login fallback. Keys never
enter the account index, list or status. Adding does not contact a server or discover models: pass its public
Pi model definitions in `models` (an omitted list is empty), including compatibility/tuning fields as needed.

`endpointRuntime` returns the complete typed Pi `Models` API (stream, complete, simple and deferred methods,
model/auth access and refresh), containing only this endpoint's models. Use models returned by that runtime;
foreign/cloned models are refused before auth. It never registers in `runtime(member)` or another member's
runtime. `getAuth` is a host-only credential handoff, never a view/log/remote-device payload. `logout` deletes
the saved key and deactivates the row; `remove` also removes its public metadata. Previously returned runtimes
refuse further authentication after either operation. Readiness/configuration is not proof the server is running.

Node/Electron use the pinned adapters directly. Browser/RN exports remain free of runtime Node/Pi imports:
without an app-supplied same-device `endpointDriver`, the route is `needs_host`. Loopback additionally requires
explicit `endpointHost: true`; its readiness is checked **before** opening any key backend. A driver must keep
credentials on this device; this seam does not authorize forwarding them to a server or borrowing a default login.

## Explicit cloud accounts (Node only)

Cloud routes are discovered alongside plans, but always chosen explicitly and billed per use. `addCloud` (also
`add(member, provider, options)`) saves configuration without a request or SDK credential check. Supply the member's
`keyStore` for API/bearer keys; there is no plaintext fallback. `list`, `status` and defaults never probe AWS/ADC files
or invoke a Workers binding. A ready cloud row means **configured**, not live authorization.

```ts
import { Accounts, type Model } from '@byokit/accounts';
declare const model: Model<'bedrock-converse-stream'>; // the app's selected pinned Pi model
const accounts = new Accounts(); // use the member's app-owned store for durable accounts
const signal = new AbortController().signal;
const { id } = await accounts.addCloud(1, 'aws-bedrock', {
  route: 'aws-bedrock:cloud:aws-profile', via: 'cloud', profile: 'work',
  home: '/person-selected/aws-home', region: 'us-east-1',
});
const stream = await accounts.cloudStream(1, id, model, {
  messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
}, { signal, maxTokens: 128 });
for await (const event of stream) { /* show typed Pi events */ }
const answer = await stream.result(); // or accounts.cloudComplete(...), returning Pi's AssistantMessage
```

| Provider/method | Explicit settings |
| --- | --- |
| Bedrock profile / SDK chain | `profile` + selected absolute `home`, or selected absolute `home`; both require `region` |
| Bedrock bearer token | `via:'key'`, `key`, `region` |
| Vertex ADC | `project`, `location`, and a picked absolute `keyFile` or selected absolute `home` |
| Vertex service account | `project`, `location`, picked absolute `keyFile` |
| Vertex API key | `via:'key'`, `key` (placeholder keys are refused, never converted to ADC) |
| Azure API key | `via:'key'`, `key`, `baseUrl` |
| Cloudflare API key | `via:'key'`, `key`, `accountId`, plus `gatewayId` for AI Gateway |
| Cloudflare Workers AI binding | `via:'cloud'`, `binding` name, `gatewayId`, explicit `https://workers-binding.ai/ai-gateway/gateways/<gateway>/<provider>` base URL; app supplies `cloudBinding(member, name)` |
| Bedrock skip-auth endpoint | `via:'endpoint'`, explicit `baseUrl`, `region` and `billing`; no key, bearer token or profile |

`route` is the exact ID from `routes()`. Paths/profiles/regions and binding names are non-secret account metadata;
keys remain exclusively in `keyStore`. The binding object is never persisted; its factory runs only for an explicit
request. The binding transport uses the pinned `createAiBindingFetch`, without an HTTP-token fallback.

AWS and Vertex SDK requests use an isolated Node child per request: no inherited provider env, proxy credentials,
`NODE_OPTIONS` or default HOME. Only the selected home/path is available; the app's `process.env` is unchanged. The SDK
chain opts into that selected home's configuration and native role resolution, not the app's environment keys.
Streams use pinned Pi adapters and native typed tuning/callback options; authentication, environment, auth headers and
account endpoints are sealed to the selection. Cancellation stops the child; public errors/events redact the selected
key. Custom fetch works with Azure/Cloudflare; SDK routes use their native transport.

For skip-auth, stock Pi signs the device-internal loopback hop with placeholder credentials; the kit's per-request
forwarder checks that placeholder signature and strips it **before egress**. The selected endpoint receives no AWS
signature. Limits: HTTP/1.1 only, no proxy/custom CA, and no endpoint `Authorization` header. Caller headers are not
unchanged: Pi drops reserved `authorization`, `host`, `x-amz-*`; the forwarder drops signing and hop-by-hop headers.
Native parameters, tools, events, usage, hooks and retry settings still use the stock adapter. No live endpoint or
vendor qualification is claimed. Browser/RN cloud operations return `unsupported_platform` before credential access;
plans never fall back to a cloud/API account.

### Portable adapter artifact

Portable key loaders lazily use `src/pi/` (published as `dist/pi/`), a deterministic split bundle of the
**unmodified** published Pi pin, not another inference engine. Node keeps using the published Pi modules.
After installing the exact pins, regenerate with `node scripts/gen-accounts-pi.ts`; a pin change also requires
verified registry provenance. Esbuild’s standard dynamic-import lowering is the sole transform; the four
SDK dependencies remain external at Pi’s exact pins. Exact MCP SDK and `undici-types` dependencies close
Google’s published declaration imports, including strict nested consumers; neither adds an inference path.
`PROVENANCE.json`, source-content maps, published-type re-exports and [NOTICE](NOTICE) travel with the
artifact. Build and prepack copy it into `dist/pi/`.

Portable requests always give Pi Models an explicit empty auth context. Never replace that with default
auth discovery: the lowered unresolved require is fatal if reached under Metro. `createProvider` has no
constructor auth-context option at this pin; Models supplies its context for auth operations. Tests check
byte reproduction and source hashes, valid seven-adapter success/tool/usage/error/abort parity, actual
cold Metro execution and lazy keys in a strict nested packed install. None requires vendor credentials.

### Typed key-route example

```ts
import { Accounts, type Model } from '@byokit/accounts';
import type { Keystore } from '@byokit/secrets';

export async function askWithKey(keyStore: (member: number) => Keystore,
  model: Model<'openai-completions'>, key: string) {
  const accounts = new Accounts({ keyStore });
  const { id } = await accounts.add(1, 'groq:key', { via: 'key', key }); // API key (billed per use), explicitly selected
  return accounts.respond(1, { account: id, model, context: {
    messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
  }, options: { temperature: 0.2 } });
}
```
