# @byokit/accounts

Sign in with the AI plan you already pay for (ChatGPT on every platform; OpenRouter on computers; Grok and GitHub
Copilot hidden by default), inside your own app, into your app's own store: on a computer (Node, Electron), in a browser
(a PWA, Electron's renderer) and on a
phone (React Native and Expo, iOS and Android). One import; your bundler picks the platform's side
(`package.json`'s `react-native` and `browser` conditions).

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

On a phone or in a browser the same `Accounts` signs in to ChatGPT by device code with `fetch` alone (Pi's flows need
Node), into the phone's secure storage or the browser's IndexedDB:

```ts
import * as SecureStore from 'expo-secure-store';
import { Accounts, secureStore } from '@byokit/accounts';

const accounts = new Accounts({ store: (member) => secureStore(SecureStore, `byokit.${member}`) });
const shown = await accounts.login(1, 'chatgpt'); // { state: 'waiting', via: 'code', code, url }: open url, show code
```

Examples: [`examples/expo`](../../examples/expo) (iOS and Android bundles; Android emulator sign-in) and
[`examples/pwa`](../../examples/pwa) (browser sign-in).

## Which sign-in works where

| | Computer (Node, Electron main) | Browser (PWA, Electron renderer) | Phone (React Native: iOS, Android) |
|---|---|---|---|
| ChatGPT | Its own page, straight back to this computer (port 1455); a code when asked or stuck | Device code | Device code |
| OpenRouter | Its own page, back to this computer (Pi's flow) | Not yet | Not yet |
| Grok, Copilot (hidden) | Pi's flows | No | No |
| Where sign-ins are kept | `fileStore(path)`, sealed with Electron's `safeStorage` when given | `browserStore(name)` (IndexedDB) | `secureStore(SecureStore, name)` (Keychain, Keystore) |

Device code works everywhere: OpenAI's sign-in endpoints answer any web page. The page-straight-back sign-in needs a
listener on the computer the browser runs on, so it is desktop only: ChatGPT sends the browser back to
`localhost:1455`, fixed for the client this signs in as. A web page can't call ChatGPT's model endpoint itself (it
doesn't answer other web pages), so a PWA's model calls go through the app's own server or relay.

- **Catalogue** (`catalogue.json`): each provider with its terms status (`allowed`, `grey`, `partner`), a one-line reason
  and a source. The kit labels; your app decides what to offer (`new Accounts({ offer: ['chatgpt'] })`). Without an
  explicit `offer`, only sign-ins supported on this platform are shown; an explicit list is not platform-filtered, so
  choose from the table above. Claude plan sign-in is never offered: Anthropic reserves it for its own apps.
- **Sign-in**: on computers, the provider's own page by default. For ChatGPT, whose page returns to this computer's
  port 1455, the kit listens there itself, so the tab shows your app's words (`new Accounts({ app: 'My App' })`) and only once they are
  true. A code takes over when asked ("Having trouble?"), when the page never comes back, or when the port is taken by
  another sign-in. A 15-minute cap, nothing kept unless the engine can use it, and every failure is one plain sentence
  (`words.json`) with a `why` for apps that word it themselves. `plan(member)` tells a work ChatGPT from a personal one.
- **Sign-out**: `logout(member, key)` attempts to revoke a ChatGPT token at OpenAI (`POST auth.openai.com/oauth/revoke`),
  then deletes the local sign-in even if the revoke fails. A failed revoke rejects after local deletion; report it because
  the remote sign-in may remain active. Within one store instance, a refresh already in progress finishes first, so
  sign-out uses its rotated token. If a cancelled sign-in finishes late, `onSignOutError` reports a failed revoke of its
  discarded credential (or it is logged when no handler is set).
- **One person, one store**: `memoryStore()`, `fileStore(path)` (0600, the same shape as Pi's `auth.json`),
  `secureStore(SecureStore, name)` or `browserStore(name)`; any other storage with `recordStore(load, save)`. Writes are
  serialized within a store instance; `browserStore` also uses Web Locks across tabs for the same provider when available.
  Never a shared fallback. Browser storage is readable by scripts on your page: avoid untrusted scripts. Using another
  engine with the same seam (Pi's coding-agent `ModelRuntime`)? Override `open(member)` with an engine whose
  `credentialStore` is made with `boundStore(member, engineStore)` and whose `readCredential(id)` reads that store.
- **Limits**: `failed(member, key, error)` rests an account until the provider said (or a default), marks a plan that
  doesn't include this use, and signs out only a sign-in that no longer refreshes. `ladder()` picks the next usable
  account; `keepFresh()` refreshes ahead of expiry. Limits come from errors only; no undocumented usage endpoint is read.
- **Isolation**: ambient discovery is off (no environment variable or credential file is ever consulted), and
  `@byokit/accounts/testing` has the decoy-HOME harness and fs tracer to prove it in your own tests.
- **A stand-in OpenAI**: `mockOpenAI()` from `@byokit/accounts/testing` (or `node .../testing/mock-openai.ts [port]`)
  answers device code, its page where a person types the code, token exchange, refresh and revoke, so tests and demos
  sign in end to end with no account. Point the kit at it with `new Accounts({ authBase })`.
