<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/wordmark-dark.svg" />
  <img src="docs/readme/wordmark-light.svg" alt="BYOKit" width="280" />
</picture>

<strong>Ship apps where people sign in with the AI plan they already pay for.</strong>

<p>TypeScript kits that let people sign in to your app with ChatGPT, Claude or other plans they already pay for, on web, phone and desktop.</p>

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/readme/agents-phone-dark.png" />
  <source media="(max-width: 600px)" srcset="docs/readme/agents-phone-light.png" />
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/agents-dark.png" />
  <img src="docs/readme/agents-light.png" width="880" alt="The PWA example's Agents page: the Codex agent runs on the ChatGPT plan Umer already pays for, its default model is listed below, and pay-per-use API keys sit in a separate group." />
</picture>

[Quick start](#quick-start) · [Packages](packages) · [Examples](examples) · [Contributing](CONTRIBUTING.md)

[![npm version of @byokit/accounts](https://img.shields.io/npm/v/@byokit/accounts?style=flat&label=accounts)](https://www.npmjs.com/org/byokit) [![Apache-2.0 license](https://img.shields.io/badge/license-Apache--2.0-666?style=flat)](LICENSE)
</div>

## Quick start

Install the published `@byokit/accounts` **0.33.0** package in an empty folder:

```sh
mkdir byokit-demo && cd byokit-demo
npm i @byokit/accounts@0.33.0
node -e "import('@byokit/accounts')
  .then(m => console.log(
  Object.keys(m.PROVIDERS).length))"
```

The last command prints how many provider routes the typed entry point exposes. Nothing signs in and no provider is called.

For the whole offline sign-in-and-answer journey, with no account, network or key, use the [accounts quick start](packages/accounts#quickstart).

## Why BYOKit

- **Instead of rebuilding each provider's sign-in by hand:** typed sign-in and provider helpers behind package APIs.
- **Instead of treating a subscription like an API key:** plan and per-use billing labelled apart, with API-key routes opt-in.
- **Instead of sending credentials to a pooling proxy:** sign-ins stored by the app and sent straight to the provider; BYOKit hosts no pooling service.
- **Instead of writing a bespoke device link:** pairing, discovery and encrypted link kits you can compose.

## What you get

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/accounts-card-dark.png" />
  <img src="docs/readme/accounts-card-light.png" width="380" alt="The accounts screen: a ChatGPT Plus account connected, the plan shown on its card, and the Ask box on the same screen." />
</picture>
</p>

- **Sign in without typing a password.** The person enters a device code on the provider's own page; the app never sees it.
- **Bill what the plan already covers.** The plan behind each account is shown on its card, not guessed, and pay-per-use API keys are listed apart.
- **Pair a phone with a computer.** Compare two words before an encrypted link is approved.
- **Put voice in the app's own screen.** Realtime voice, audio and dictation kits, not a bolted-on window.

These are captures of the examples in this repository, run with local stand-ins and the demo person Umer. No personal account and no live provider is involved.

## Proof

- **Published releases.** [`@byokit/accounts`](https://www.npmjs.com/package/@byokit/accounts) is at **0.33.0** and [`@byokit/pair`](https://www.npmjs.com/package/@byokit/pair) at **0.10.4**; every version and its notes are in the [release history](https://github.com/umeranjum17/byokit/releases).
- **Tests and types.** The [CI workflow](.github/workflows/ci.yml) builds every package, type-checks sources and tests, and runs the suite. Rerun it yourself with `npm ci --no-audit --no-fund`, `npm run build`, `npm run check`, `npm test` (details in [contributing](CONTRIBUTING.md)).
- **Runnable examples.** [Web/PWA](examples/pwa), [Expo and React Native](examples/expo), [offline voice](examples/realtime-voice) and [computer pairing](examples/herdr-kit) are apps in this repository, not screenshots of one.
- **What is not claimed here.** There are no user counts, quotes or benchmark numbers on this page; the links above are the evidence, and each one can be opened or rerun.

## Packages

- **Sign in and understand plans** — [accounts](packages/accounts), [usage](packages/usage)
- **Pair devices and communicate** — [pair](packages/pair), [discover](packages/discover), [relay](packages/relay), [link](packages/link), [signaling](packages/signaling)
- **Voice and on-device AI** — [realtime](packages/realtime), [audio](packages/audio), [dictation](packages/dictation), [infer](packages/infer), [speak](packages/speak)
- **Decide and connect tools** — [decide](packages/decide), [connect](packages/connect), [mcp](packages/mcp)
- **Runtime and app capabilities** — [openclaw](packages/openclaw), [herdr](packages/herdr), [cloud](packages/cloud), [browser](packages/browser), [phone](packages/phone), [record](packages/record), [bubble](packages/bubble), [overlay](packages/overlay), [statusbar](packages/statusbar)
- **UI and private data** — [ui](packages/ui), [ui-core](packages/ui-core), [secrets](packages/secrets), [seal](packages/seal), [push](packages/push), [outbox](packages/outbox), [write](packages/write)

Some kits are private, deprecated or still awaiting qualification; each package guide states its status and platform support. [Browse all package guides](packages).

<details>
<summary>More: docs, security and project details</summary>

- [Web example](examples/pwa) · [Mobile example](examples/expo) · [Voice example](examples/realtime-voice)
- [Runtime kits](docs/runtime-kits.md) · [Capability kits](docs/capability-kits.md) · [Cloud kit](docs/cloud-kit.md)
- [Vision](VISION.md) · [Package conventions](docs/kit-conventions.md) · [Contributing and platform checks](CONTRIBUTING.md)
- [Account security notes](packages/accounts/SECURITY.md) · [Relay security boundary](packages/relay/SECURITY.md)
- [Releases](https://github.com/umeranjum17/byokit/releases) · [Report a problem](https://github.com/umeranjum17/byokit/issues)
- [Previous README reference](docs/readme-reference.md) keeps the earlier install details and links.

</details>

## Contributing

```sh
npm ci --no-audit --no-fund
npm run build && npm run check
npm test
```

## License

[Apache-2.0](LICENSE) · [Notices](NOTICE)
