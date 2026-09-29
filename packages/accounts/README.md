<h1 align="center">@byokit/accounts</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/accounts"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/accounts?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node | Electron | browsers | React Native" src="https://img.shields.io/badge/platform-Node%20%7C%20Electron%20%7C%20browsers%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>Sign in with the AI plan you already pay for, inside your own app.</strong><br/>
ChatGPT on every platform; OpenRouter on computers when an app offers it (API billing, never by default); Grok and
GitHub Copilot hidden by default. Sign-ins go into your app's own store: on a computer (Node, Electron), in a browser
(a PWA, Electron's renderer) and on a phone (React Native and Expo, iOS and Android). One import; your bundler picks
the platform's side (`package.json`'s `react-native` and `browser` conditions).</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/pwa-1-signed-out.png" width="240" alt="The page &quot;byokit in a browser&quot;, signed out: &quot;ChatGPT isn't signed in yet.&quot; above a Sign in with ChatGPT button" />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/pwa-2-code.png" width="240" alt="The same page signing in: &quot;Signing in to ChatGPT…&quot;, &quot;On the ChatGPT page, type this code:&quot; MOCK-10001, an Open ChatGPT link and a Cancel button" />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/pwa-3-connected.png" width="240" alt="The same page signed in: &quot;ChatGPT is connected.&quot;, sara@example.com, plus plan, with Check the sign-in and Sign out buttons" />
</p>
<p align="center"><sub><a href="../../examples/pwa"><code>examples/pwa</code></a> signing in by device code in headless Chromium (Playwright), against the kit's stand-in OpenAI (<code>mockOpenAI()</code>), not the real one: hence the code <code>MOCK-10001</code>.</sub></p>

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
import { isolate } from '@byokit/accounts/isolate'; // first, before any Pi import
isolate('/path/to/app/engine');                     // scrub inherited Pi settings and provider keys
import { Accounts, fileStore } from '@byokit/accounts';

const accounts = new Accounts({ store: (member) => fileStore(`/path/to/app/people/${member}/auth.json`) });
const shown = await accounts.login(1, 'chatgpt', { via: 'code' }); // { state: 'waiting', code, url }
// show shown.code and shown.url; the sign-in finishes by itself
(await accounts.status(1, 'chatgpt')).words;                     // "ChatGPT is connected."
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
| `memoryStore`, `fileStore`, `secureStore`, `browserStore`, `recordStore` | One store per person: in memory, a 0600 file (Node entry only), Keychain/Keystore, IndexedDB, or your own load and save |
| `offered`, `provider`, `PROVIDERS` | The catalogue: each provider's billing, terms status, reason and source |
| `billingWords`, `say`, `WORDS`, `signInError`, `failure`, `clock`, `callbackPage` | The plain sentences every app shows the same way (`words.json`), a time in words, and the page a browser sees after a sign-in |
| `respond`, `ResponseError`, `sseReader`, `limitResponse` | Ask ChatGPT's answers endpoint with a sign-in; the error with the words to show and the kind acted on |
| `classify`, `REST_MS` | An error's kind (limit, overload, plan without this use, lapsed sign-in, network) and default rest times |
| `planOf`, `claims` | The ChatGPT plan and email behind a sign-in, from its own token |
| `deviceStart`, `devicePoll`, `credentialOf`, `portableEngine`, `PORTABLE` | The device-code flow, the sign-in built from a token answer, and the engine under `portable` |
| `isolate`, `INHERITED`, `emptyAuthContext` (`/isolate`) | Scrub inherited Pi settings and provider keys; ambient discovery off |
| `mockOpenAI`, `mockJwt`, `decoy`, `traceFs`, `CANARY` (`/testing`) | A stand-in OpenAI, and the decoy-HOME harness and fs tracer for isolation tests |

`computer`, `loopback` and `fileStore` come from the Node entry only; `isolate` and `/testing` need Node too.

## Which sign-in works where

| | Computer (Node, Electron main) | Browser (PWA, Electron renderer) | Phone (React Native: iOS, Android) |
|---|---|---|---|
| ChatGPT (subscription) | Its own page, straight back to this computer (port 1455); a code when asked or stuck | Device code | Device code |
| OpenRouter (API billing) | Its own page, back to this computer (Pi's flow), when an app offers it (never by default) | Not yet | Not yet |
| Grok, Copilot (hidden) | Pi's flows | No | No |
| Where sign-ins are kept | `fileStore(path)`, sealed with Electron's `safeStorage` when given | `browserStore(name)` (IndexedDB) | `secureStore(SecureStore, name)` (Keychain, Keystore) |

Device code works everywhere: OpenAI's sign-in endpoints answer any web page. The page-straight-back sign-in needs a
listener on the computer the browser runs on, so it is desktop only: ChatGPT sends the browser back to
`localhost:1455`, fixed for the client this signs in as. A web page can't call ChatGPT's model endpoint itself (it
doesn't answer other web pages), so a PWA's model calls go through the app's own server or relay.

## Catalogue and billing

`catalogue.json` holds each provider with its billing (`subscription`, `api`) and terms status (`allowed`, `grey`,
`partner`), a one-line reason and a source. The kit labels; your app decides what to offer
(`new Accounts({ offer: ['chatgpt'] })`). Without an explicit `offer`, only subscription sign-ins supported on this
platform are shown: OpenRouter is API-billed and never offered by default. An explicit list is not platform-filtered,
so choose from the table above. Show `billingWords(p)` next to every provider you list.

Claude plan sign-in is never offered: Anthropic reserves it for its own apps.

```ts
import { Accounts, billingWords, offered } from '@byokit/accounts';

console.log(new Accounts().providers.map((p) => p.key)); // the default offer on a computer
for (const p of offered(['chatgpt', 'openrouter'])) console.log(`${p.name}: ${billingWords(p)}`);
```

```text
[ 'chatgpt' ]
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
cancelled sign-in finishes late, `onSignOutError` reports a failed revoke of its discarded credential (or it is logged
when no handler is set).

## One person, one store

`memoryStore()`, `fileStore(path)` (0600, the same shape as Pi's `auth.json`), `secureStore(SecureStore, name,
options?)` or `browserStore(name)`; any other storage with `recordStore(load, save)`. Writes are serialized within a
store instance; `browserStore` also uses Web Locks across tabs for the same provider when available. Never a shared
fallback.

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
