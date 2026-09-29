<h1 align="center">byokit</h1>

<p align="center">
  <a href="https://www.npmjs.com/org/byokit"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/accounts?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node, browsers, iOS and Android" src="https://img.shields.io/badge/platform-Node%20%7C%20browsers%20%7C%20iOS%20%7C%20Android-666?style=flat" />
</p>

<p align="center">
  <strong>Bring your own AI plan and devices.</strong><br/>
  byokit is a set of TypeScript packages for apps that run on the person's own AI plan and their own devices. Sign in
  with the ChatGPT plan they already pay for, pair their phone with their computer over one encrypted link, and let the
  phone drive what runs at home. Credentials stay on the person's computer or phone, in your app's own store.
</p>

<h3 align="center"><a href="#quickstart"><ins>Get started</ins></a></h3>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#packages">Packages</a> ·
  <a href="examples">Examples</a> ·
  <a href="docs/runtime-kits.md">Runtime kits</a> ·
  <a href="docs/capability-kits.md">Capability kits</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="docs/images/hero.png" alt="Four phone screens: a browser showing a ChatGPT sign-in code, a phone showing two words to compare while pairing, a list of agents ready for you, and an agent's question with Enter, y, n and Esc buttons" width="960" /><br/>
  <sub>Captured with headless Chromium from <a href="examples/pwa"><code>examples/pwa</code></a> and <a href="examples/herdr-kit"><code>examples/herdr-kit</code></a>, against the kit's stand-in OpenAI and Herdr.</sub>
</p>

## Install

Every published package is on npm and ships a per-package GitHub release tagged `<pkg>-v<version>`.
The badges below always show the current version; each release link lists that package's releases with the
latest first, so neither goes stale.

| Package | Install | npm | Latest release |
|---|---|---|---|
| `@byokit/accounts` | `npm install @byokit/accounts` | [![npm](https://img.shields.io/npm/v/@byokit/accounts?style=flat&label=)](https://www.npmjs.com/package/@byokit/accounts) | [accounts-v releases](https://github.com/umeranjum17/byokit/releases?q=accounts-v) |
| `@byokit/ui-core` | `npm install @byokit/ui-core` | [![npm](https://img.shields.io/npm/v/@byokit/ui-core?style=flat&label=)](https://www.npmjs.com/package/@byokit/ui-core) | [ui-core-v releases](https://github.com/umeranjum17/byokit/releases?q=ui-core-v) |
| `@byokit/seal` | `npm install @byokit/seal` | [![npm](https://img.shields.io/npm/v/@byokit/seal?style=flat&label=)](https://www.npmjs.com/package/@byokit/seal) | [seal-v releases](https://github.com/umeranjum17/byokit/releases?q=seal-v) |
| `@byokit/link` | `npm install @byokit/link` | [![npm](https://img.shields.io/npm/v/@byokit/link?style=flat&label=)](https://www.npmjs.com/package/@byokit/link) | [link-v releases](https://github.com/umeranjum17/byokit/releases?q=link-v) |
| `@byokit/relay` | `npm install @byokit/relay @byokit/link` | [![npm](https://img.shields.io/npm/v/@byokit/relay?style=flat&label=)](https://www.npmjs.com/package/@byokit/relay) | [relay-v releases](https://github.com/umeranjum17/byokit/releases?q=relay-v) |
| `@byokit/reach` | `npm install @byokit/reach` | [![npm](https://img.shields.io/npm/v/@byokit/reach?style=flat&label=)](https://www.npmjs.com/package/@byokit/reach) | [reach-v releases](https://github.com/umeranjum17/byokit/releases?q=reach-v) |
| `@byokit/decide` | `npm install @byokit/decide` | [![npm](https://img.shields.io/npm/v/@byokit/decide?style=flat&label=)](https://www.npmjs.com/package/@byokit/decide) | [decide-v releases](https://github.com/umeranjum17/byokit/releases?q=decide-v) |
| `@byokit/herdr` | `npm install @byokit/herdr` | [![npm](https://img.shields.io/npm/v/@byokit/herdr?style=flat&label=)](https://www.npmjs.com/package/@byokit/herdr) | [herdr-v releases](https://github.com/umeranjum17/byokit/releases?q=herdr-v) |
| `@byokit/openclaw` | not on npm (private) — build from source: `npm ci && npm run build` | in development | [all releases](https://github.com/umeranjum17/byokit/releases) |
| `@byokit/compose` | not on npm (private) — build from source: `npm ci && npm run build` | in development | [all releases](https://github.com/umeranjum17/byokit/releases) |
| `@byokit/capture` | not on npm (private) — build from source: `npm ci && npm run build` | in development | [all releases](https://github.com/umeranjum17/byokit/releases) |
| `@byokit/overlay` | not on npm (private) — build from source: `npm ci && npm run build` | in development | [all releases](https://github.com/umeranjum17/byokit/releases) |

Unpacked sizes as of accounts 0.4.1, decide 0.2.0, herdr 0.1.0, link 0.3.1, reach 0.2.0, relay 0.1.3, seal 0.1.0,
ui-core 0.2.0 (npm `dist.unpackedSize`): accounts ~117 kB, decide ~36 kB, herdr ~279 kB, link ~151 kB,
reach ~47 kB, relay ~70 kB, seal ~20 kB, ui-core ~24 kB. Each tarball's sha512 integrity is published with the
release on npm — see its npm page, or run `npm view @byokit/<pkg> dist.integrity dist.tarball`.

The [`examples/`](examples) apps are not published artifacts: run them from a clone (see
[Quickstart](#quickstart)). For every release across packages, see
[releases](https://github.com/umeranjum17/byokit/releases).

## Why byokit exists

People already pay for an AI plan, and they already carry a phone. An app that wants to use either usually asks for an
API key billed per use, or runs everything through its own servers. byokit is the other way: the person signs in with
their subscription inside your app, the sign-in is kept where your app keeps its data, and their phone talks to their
own computer, which holds every credential.

Every provider is labelled with how it is billed. Subscription sign-ins are offered by default; API-billed ones only
when an app chooses to offer them.

## See it in action

### Sign in with the plan you already pay for

`@byokit/accounts` signs a person in to ChatGPT by device code in a browser or on a phone, and with ChatGPT's own page
on a computer. Every state is one plain sentence your app can show.

<p align="center">
  <img src="docs/images/pwa-1-signed-out.png" alt="byokit in a browser: ChatGPT isn't signed in yet, with a Sign in with ChatGPT button" width="240" />
  <img src="docs/images/pwa-3-connected.png" alt="ChatGPT is connected, sara@example.com, plus plan, with Check the sign-in and Sign out" width="240" /><br/>
  <sub><a href="examples/pwa"><code>examples/pwa</code></a> in headless Chromium, signed in against the stand-in OpenAI (<code>mockOpenAI()</code>).</sub>
</p>

### Pair a phone with one scan

`@byokit/link` pairs a phone or browser with the computer from a QR code or a typed code, then carries requests and
streams over one end-to-end encrypted link. Both screens show the same two words before the person says yes.

<p align="center">
  <img src="docs/images/herdr-kit-host.png" alt="A terminal running the Herdr kit example: a pairing QR code, then On the phone, scan this, or open http://192.168.1.144:7310/ and type a code, Codes last five minutes, Connected to Herdr" width="420" /><br/>
  <sub>The host of <a href="examples/herdr-kit"><code>examples/herdr-kit</code></a> (<code>npm start -- --herdr "$(command -v herdr)" --via lan --name 'Kitchen computer'</code>), pictured against the kit's stand-in Herdr (<code>BYOKIT_EXAMPLE_FAKE=1</code>); the phone's side of the pairing, the two words, is the second screen at the top.</sub>
</p>

### Drive the agents at home from the phone

`@byokit/herdr` drives the Herdr on the computer: start a coding agent, send it a message, and answer it when it stops
to ask. Each agent keeps its own subscription sign-in; the kit never sees a credential.

<p align="center">
  <img src="examples/herdr-kit/docs/5-answered.png" alt="Answered with y: the question is gone, the agent's screen ends in y and npm test: 42 passing, and both pi agents are Ready for you again" width="240" /><br/>
  <sub>After answering the question in the last screen at the top: <a href="examples/herdr-kit"><code>examples/herdr-kit</code></a>'s end-to-end test in a phone-sized headless Chromium, against the kit's stand-in Herdr.</sub>
</p>

### And the parts in between

- **Decide, don't guess.** `@byokit/decide` turns typed questions into a typed answer with a confidence, and abstains
  below a floor so your app asks the person instead.
- **Reach the computer.** `@byokit/reach` finds the addresses a phone can dial (Tailscale Serve, the tailnet, the home
  network) and `@byokit/relay` routes link frames when there is no direct path, without being able to read them.
- **Keep data sealed.** `@byokit/seal` is portable NaCl-compatible box, secretbox and signatures for data at rest.
- **Your own look.** `@byokit/ui-core` is the headless state behind the screens above: sign-in phases, the pairing
  QR, consent and status words.

## Packages

| Package | What it does | npm |
|---|---|---|
| [`@byokit/accounts`](packages/accounts) | Sign in with the AI plan you already pay for, into your app's own store; limits, refresh, plain words. Node, Electron, browsers and PWAs, React Native on iOS and Android | [![npm](https://img.shields.io/npm/v/@byokit/accounts?style=flat&label=)](https://www.npmjs.com/package/@byokit/accounts) |
| [`@byokit/ui-core`](packages/ui-core) | Headless sign-in and pairing state for any UI (React, React Native, or none): phases, QR, consent, link words, route labels | [![npm](https://img.shields.io/npm/v/@byokit/ui-core?style=flat&label=)](https://www.npmjs.com/package/@byokit/ui-core) |
| [`@byokit/seal`](packages/seal) | Portable NaCl-compatible box and secretbox for data at rest, plus Ed25519 signatures | [![npm](https://img.shields.io/npm/v/@byokit/seal?style=flat&label=)](https://www.npmjs.com/package/@byokit/seal) |
| [`@byokit/link`](packages/link) | Scan a code to pair a phone or browser with the home computer over one encrypted link, with device stores for phones, browsers and computers; muxr parity tracked separately | [![npm](https://img.shields.io/npm/v/@byokit/link?style=flat&label=)](https://www.npmjs.com/package/@byokit/link) |
| [`@byokit/relay`](packages/relay) | Routes encrypted link frames; enrolment, typed-code lookup, push ([security boundary](packages/relay/SECURITY.md)) | [![npm](https://img.shields.io/npm/v/@byokit/relay?style=flat&label=)](https://www.npmjs.com/package/@byokit/relay) |
| [`@byokit/reach`](packages/reach) | The addresses a phone dials the home computer on (Tailscale Serve, direct tailnet, LAN) plus mDNS advertising (Node) and browsing (React Native) | [![npm](https://img.shields.io/npm/v/@byokit/reach?style=flat&label=)](https://www.npmjs.com/package/@byokit/reach) |
| [`@byokit/decide`](packages/decide) | Typed questions in, a typed answer with confidence out, abstaining below a floor; rules, Jev (API-billed) or any model (the person's own ChatGPT on a phone), evals | [![npm](https://img.shields.io/npm/v/@byokit/decide?style=flat&label=)](https://www.npmjs.com/package/@byokit/decide) |
| [`@byokit/openclaw`](packages/openclaw) | The OpenClaw runtime kit: the pinned engine's full operator surface as typed pass-through calls, plus plain-words helpers for members, sign-in, runs and approvals, for apps where the aggregator holds the subscriptions ([spec](docs/runtime-kits.md)) | in development |
| [`@byokit/herdr`](packages/herdr) | Drive the Herdr on this computer — workspaces, panes, agents, blocked-approval answers — from an app, or hand it to a phone over a link, for apps where the aggregator holds the subscriptions ([spec](docs/runtime-kits.md)) | [![npm](https://img.shields.io/npm/v/@byokit/herdr?style=flat&label=)](https://www.npmjs.com/package/@byokit/herdr) |
| [`@byokit/compose`](packages/compose) | Drafting in a person's voice with no model call: voice rules, platform limits, draft checks (fits, voice, kept the facts) and thread splits over a pinned writing engine, plus an agent CLI ([spec](docs/capability-kits.md)) | in development |
| [`@byokit/capture`](packages/capture) | Record a screen or a desktop and make a video, through any recorder implementing the open recorder protocol v1 the kit defines ([spec](docs/capability-kits.md)) | in development |
| [`@byokit/overlay`](packages/overlay) | A floating bubble over other apps on Android (Expo module): a panel that opens on tap, per-app visibility rules, a tap log with no text and an optional focused-field reader; iOS reports unsupported ([spec](docs/capability-kits.md)) | in development |

## Quickstart

You need [Node.js 22.18 or newer](https://nodejs.org/).

```bash
npm install @byokit/accounts
```

In a browser or PWA, sign the person in to ChatGPT and keep the sign-in in the browser's IndexedDB:

```ts
import { Accounts, browserStore } from '@byokit/accounts';

const accounts = new Accounts({ store: (member) => browserStore(`byokit.${member}`) });
const shown = await accounts.login(1, 'chatgpt'); // { state: 'waiting', via: 'code', code, url }: open url, show code
await accounts.finished(1, 'chatgpt');
(await accounts.status(1, 'chatgpt')).words;      // "ChatGPT is connected."
```

A web page can't call ChatGPT's model endpoint itself, so a PWA asks through your own server or over
[`@byokit/link`](packages/link). On a computer, on a phone and for asking, see [`@byokit/accounts`](packages/accounts).

### Try it with no account

`mockOpenAI()` stands in for OpenAI's sign-in and answers on loopback, so the whole flow runs with no account, no
network and no model:

```ts
import { Accounts, memoryStore } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';

const openai = await mockOpenAI(); // a stand-in OpenAI on loopback: no account, no network
const accounts = new Accounts({ store: () => memoryStore(), authBase: openai.base, apiBase: openai.base });

const shown = await accounts.login(1, 'chatgpt');
console.log(shown);                                  // the code and page to show the person
openai.approve(shown!.code!);                        // the person types it on the provider's page
await accounts.finished(1, 'chatgpt');
console.log((await accounts.status(1, 'chatgpt')).words);
console.log(await accounts.respond(1, { instructions: 'Answer briefly.', input: 'Plan my day' }));
await openai.close();
```

Run it as a browser or phone would (`node --conditions=browser quickstart.ts`):

```text
{
  state: 'waiting',
  via: 'code',
  url: 'http://127.0.0.1:39925/codex/device',
  code: 'MOCK-10001',
  expiresAt: 1790668740492,
  error: undefined,
  why: undefined
}
ChatGPT is connected.
You said: Plan my day
```

### Run the examples

```bash
git clone https://github.com/umeranjum17/byokit
cd byokit
npm ci
npm run build
node examples/pwa/serve.ts 8080                        # the browser sign-in page on http://127.0.0.1:8080/
cd examples/herdr-kit && BYOKIT_EXAMPLE_FAKE=1 npm start -- --via lan   # the phone page, against the stand-in Herdr
```

`examples/herdr-kit` is not a workspace of its own: from a clone it runs on the root install's packages, as above.
With a real Herdr, see its [README](examples/herdr-kit).

Examples: [`examples/expo`](examples/expo) (React Native, iOS and Android), [`examples/pwa`](examples/pwa)
(an installable web page) and [`examples/herdr-kit`](examples/herdr-kit) (Herdr's agents from a phone browser). For
platform checks and their limits, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Billing, honestly

`catalogue.json` labels every provider with its billing (`subscription` or `api`) and its terms status. ChatGPT is a
subscription sign-in on every platform. OpenRouter is API-billed and only on computers, and is never offered unless an
app lists it itself; Grok and GitHub Copilot are hidden by default. Claude plan sign-in is never offered: Anthropic
reserves it for its own apps. Show `billingWords(p)` next to every provider you list.

## What byokit never touches

byokit never touches a person's other AI tools: not their `~/.pi`, `~/.codex` or `~/.claude`, not their CLIs.
Runtime kits drive only the aggregator the app names explicitly (the OpenClaw engine the kit installs, the Herdr
binary and socket the app passes); byokit tests use fakes and never a person's Herdr.
Capability kits have their own, narrower carve-out: `@byokit/compose` loads only its exactly pinned public writing
engine package, and `@byokit/capture` spawns only a recorder implementing recorder protocol v1 that the app passes by
absolute path, with an environment built from nothing; `@byokit/overlay` runs only its own native code inside the
app ([spec](docs/capability-kits.md)).
Library code never reads environment keys; the explicitly invoked [decide eval CLI](packages/decide#evals) can use one
for a live run. The tests prove isolation; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
git clone https://github.com/umeranjum17/byokit
cd byokit
npm ci
npm run build
npm run check
npm test
```

Tests never need an account, the network or a model. See [CONTRIBUTING.md](CONTRIBUTING.md) for platform checks,
the changelog format, releasing and pull requests.

## License

byokit is licensed under [Apache License 2.0](LICENSE). Third-party notices are recorded in [NOTICE](NOTICE).
