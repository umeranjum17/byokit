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
import { isolate } from '@byokit/accounts/isolate'; // first, before any Pi import
isolate('/path/to/app/engine');                     // scrub inherited Pi settings and provider keys

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

The same `Accounts` signs in to ChatGPT by device code with `fetch` alone (Pi's flows need Node), into the phone's
secure storage or the browser's IndexedDB:

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
| `Accounts` | Sign-in, status, sign-out, asking and limits for each member: `login`, `finished`, `status`, `plan`, `logout`, `respond`, `failed`, `ladder`, `keepFresh` |
| `portable`, `computer`, `loopback` | The platform `Accounts` runs on: device code with `fetch` alone, or (Node entry only) Pi's flows and the loopback listener |
| `memoryStore`, `fileStore`, `secureStore`, `browserStore`, `recordStore` | One store per person: in memory, a sealed 0600 file (Node entry only), Keychain/Keystore, IndexedDB, or your own load and save |
| `offered`, `provider`, `PROVIDERS` | The catalogue: each provider's billing, models and source |
| `billingWords`, `say`, `WORDS`, `signInError`, `failure`, `clock`, `callbackPage` | The plain sentences every app shows the same way (`words.json`), a time in words, and the page a browser sees after a sign-in |
| `respond`, `ResponseError`, `IncompleteError`, `sseReader`, `limitResponse`, `isFunctionCall` | Ask ChatGPT's answers endpoint with a sign-in, with tools, pictures, thinking effort and an answer shape; the error with the words to show and the kind acted on |
| `classifyFailure`, `classify`, `REST_MS` | An error's kind (limit, overload, plan without this use, lapsed sign-in, network) and default rest times |
| `planOf`, `claims` | The ChatGPT plan and email behind a sign-in, from its own token |
| `deviceStart`, `devicePoll`, `credentialOf`, `portableEngine`, `PORTABLE` | The device-code flow, the sign-in built from a token answer, and the engine under `portable` |
| `isolate`, `INHERITED`, `emptyAuthContext` (`/isolate`) | Scrub inherited Pi settings and provider keys; ambient discovery off |
| `mockOpenAI`, `mockJwt`, `decoy`, `traceFs`, `CANARY` (`/testing`) | A stand-in OpenAI, and the decoy-HOME harness and fs tracer for isolation tests |

`computer`, `loopback` and `fileStore` come from the Node entry only; `isolate` and `/testing` need Node too.

## Which sign-in works where

| | Computer (Node, Electron main) | Browser (PWA, Electron renderer) | Phone (React Native: iOS, Android) |
|---|---|---|---|
| ChatGPT (subscription) | Its own page, straight back to this computer (port 1455); a code when asked or stuck | Device code | Device code |
| Claude Pro/Max (subscription) | Provider page, paste its code back | Same PKCE flow; token endpoint CORS required | Same PKCE flow; app supplies Web Crypto |
| Anthropic (API key, billed per use) | App passes its own key, explicitly | Same fetch-only Messages provider | Same fetch-only Messages provider |
| OpenRouter (API billing) | Its own page, back to this computer (Pi's flow), when an app offers it (never by default) | Not yet | Not yet |
| Grok, Copilot, Kimi, Meta | Pi's flows | No | No |
| Where sign-ins are kept | `fileStore(path, safeStorage)`, sealing required | `browserStore(name)` (IndexedDB) | `secureStore(SecureStore, name)` (Keychain, Keystore) |

Device code works everywhere: OpenAI's sign-in endpoints answer any web page. The page-straight-back sign-in needs a
listener on the computer the browser runs on, so it is desktop only: ChatGPT sends the browser back to
`localhost:1455`, fixed for the client this signs in as. A web page can't call ChatGPT's model endpoint itself (it
doesn't answer other web pages), so a PWA's model calls go through the app's own server or relay.

## Catalogue and billing

`catalogue.json` holds each provider's billing (`subscription`, `api`), models and source.
All subscription rows are offered by default on platforms that support their sign-in. API-billed rows
are offered only when the app names them. An explicit `offer` list is not platform-filtered.
The `Provider` shape no longer has `terms`, `hidden` or `why`, and `Terms` is no longer exported.
Qwen and MiniMax have subscription catalogue rows; their paste and portal sign-in flows follow in later work packages.
Each provider's own terms apply to how you use your plan.
Anthropic Messages uses an app-passed API key (billed per use); authentication is separate from the Messages request.

```ts
import { Accounts, billingWords, offered } from '@byokit/accounts';

console.log(new Accounts().providers.map((p) => p.key)); // the default offer on a computer
for (const p of offered(['chatgpt', 'openrouter'])) console.log(`${p.name}: ${billingWords(p)}`);
```

```text
[ 'chatgpt', 'claude' ]
ChatGPT: Uses your ChatGPT plan.
OpenRouter: Charged per use to your OpenRouter account, not a plan.
```

## Sign-in

On computers, the provider's own page by default. For ChatGPT, whose page returns to this computer's port 1455, the
kit listens there itself, so the tab shows your app's words (`new Accounts({ app: 'My App' })`) and only once they are
true. A code takes over when asked ("Having trouble?"), when the page never comes back, or when the port is taken by
another sign-in.

A 15-minute cap, nothing kept unless the engine can use it, and every failure is one plain sentence (`words.json`)
with a `why` for apps that word it themselves. `plan(member)` tells a work ChatGPT from a personal one.

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
store instance; `browserStore` also uses Web Locks across tabs for the whole record when available. Never a shared
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
  permissions permit; on POSIX the directory is synced too. Process restart retains the attempt. Use one instance per
  path and a host lock across processes. On Windows or with Node's permission model, power-loss durability is best-effort.
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
returned completion is authoritative). A limit or a lapsed sign-in is acted on as `failed()` does, then thrown as a
`ResponseError` with the words to show and the kind acted on. Rules: [conformance fixtures](../../fixtures/README.md).

A cut-off answer always throws `IncompleteError` (a `ResponseError` with `kind: null`), with or without tools.
Its `reason` preserves the provider's `incomplete_details.reason`, including `max_output_tokens` and
`content_filter` (`unknown` when absent). Its `result` holds the partial `{ text, output }` for apps that want to
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

## Links

- [byokit](../../README.md): every package and example
- [`examples/pwa`](../../examples/pwa) (browser sign-in) and [`examples/expo`](../../examples/expo) (React Native, iOS
  and Android)
- [Conformance fixtures](../../fixtures/README.md)
- [CHANGELOG](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).

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
files must be private regular files. Reuse one store instance for each path; a host lock is required
if several processes write the same file. See [SECURITY.md](SECURITY.md) for the threat model and limits.

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

Anthropic's [developer guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) prohibits third-party Claude.ai login without approval; BYOKit has no approval, and this route may stop working or lead to account restrictions (the separately billed API-key route is the documented alternative).

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
its sealed file writes atomically with mode 0600; a sealing adapter is required. Use one process per file (or a host-supplied cross-process lock).
Phones use `secureStore` with device-only accessibility. PWA `browserStore` uses IndexedDB and Web Locks; page
scripts can read its credentials. Tokens are never collected by a BYOKit server or logged. The default is memory-only.

React Native hosts pass `claudePlan: { crypto: webCrypto }` when global Web Crypto is unavailable;
`ClaudePlanPlatformError` reports missing secure randomness/SHA-256. Browsers require the provider token endpoint's
CORS support; a network/CORS failure stays on-device and does not trigger a proxy. Browser User-Agent restrictions
can affect compatibility. Tests replay protocol-shaped captures offline; no live OAuth, CORS, or current inference
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
