# @byokit/accounts

Sign in with the AI plan you already pay for (ChatGPT, OpenRouter; Grok and GitHub Copilot on request), inside your
own app, into your app's own store. Built on Pi's [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
sign-in flows, pinned exactly.

```ts
import { isolate } from '@byokit/accounts/isolate'; // first, before any Pi import
isolate('/path/to/app/engine');                     // scrub inherited Pi settings and provider keys
import { Accounts, fileStore } from '@byokit/accounts';

const accounts = new Accounts({ store: (member) => fileStore(`/path/to/app/people/${member}/auth.json`) });
const shown = await accounts.login(1, 'chatgpt', { via: 'code' }); // { state: 'waiting', code, url }
// show shown.code and shown.url; the sign-in finishes by itself
(await accounts.status(1, 'chatgpt')).words;                     // "ChatGPT is connected."
```

- **Catalogue** (`catalogue.json`): each provider with its terms status (`allowed`, `grey`, `partner`), a one-line reason
  and a source. The kit labels; your app decides what to offer (`new Accounts({ offer: ['chatgpt', 'grok'] })`).
  Claude plan sign-in is never offered: Anthropic reserves it for its own apps.
- **Sign-in**: the provider's own page by default. For ChatGPT, whose page returns to this computer's port 1455, the kit
  listens there itself, so the tab shows your app's words (`new Accounts({ app: 'My App' })`) and only once they are
  true. A code takes over when asked ("Having trouble?"), when the page never comes back, or when the port is taken by
  another sign-in. A 15-minute cap, nothing kept unless the engine can use it, and every failure is one plain sentence
  (`words.json`) with a `why` for apps that word it themselves. `plan(member)` tells a work ChatGPT from a personal one.
- **Sign-out**: `logout(member, key)` also ends a ChatGPT sign-in at OpenAI (`POST auth.openai.com/oauth/revoke`, as
  Codex's own sign-out does), then deletes it here whatever OpenAI answers. It reads the sign-in from `store(member)`, so
  an engine with its own store (an overridden `open`) is signed out here only.
- **One person, one store**: `memoryStore()` or `fileStore(path)` (0600, the same shape as Pi's `auth.json`). Never a
  shared fallback. Using another engine with the same seam (Pi's coding-agent `ModelRuntime`)? Override `open(member)`.
- **Limits**: `failed(member, key, error)` rests an account until the provider said (or a default), marks a plan that
  doesn't include this use, and signs out only a sign-in that no longer refreshes. `ladder()` picks the next usable
  account; `keepFresh()` refreshes ahead of expiry. Limits come from errors only; no undocumented usage endpoint is read.
- **Isolation**: ambient discovery is off (no environment variable or credential file is ever consulted), and
  `@byokit/accounts/testing` has the decoy-HOME harness and fs tracer to prove it in your own tests.
