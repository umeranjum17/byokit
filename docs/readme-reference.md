<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme/wordmark-dark.svg" />
    <img src="docs/readme/wordmark-light.svg" alt="byokit" width="280" />
  </picture>
</p>

<p align="center"><strong>Bring your own AI plan and devices.</strong><br />
Small TypeScript kits for apps that feel like yours.</p>

<p align="center">
  <a href="https://www.npmjs.com/org/byokit"><img alt="Packages" src="https://img.shields.io/npm/v/@byokit/accounts?style=flat&label=packages&color=42745a" /></a>
  <a href="CONTRIBUTING.md"><img alt="Web, mobile and desktop" src="https://img.shields.io/badge/platforms-web%20%7C%20mobile%20%7C%20desktop-686d68?style=flat" /></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache%202.0-686d68?style=flat" /></a>
</p>

<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/readme/talk-dark.png" />
    <source media="(max-width: 600px) and (prefers-color-scheme: light)" srcset="docs/readme/talk-light.png" />
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme/hero-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/readme/hero-light.png" />
    <img src="docs/readme/hero-light.png" alt="Real example screens: a tap-to-talk microphone listening, and a phone comparing two words before pairing with a computer." width="960" />
  </picture><br />
  <sub>Real example screens. Demo data. Cropped for clarity.</sub>
</p>

<p align="center">
  <a href="#quick-start">Try the demo</a> ·
  <a href="#pick-the-parts-you-need">Find a kit</a> ·
  <a href="examples">Explore the examples</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

## Make it theirs

People already have an AI plan, a phone and a computer. Let your app work with what they have.

byokit gives you the parts: sign-in, encrypted pairing, voice, usage and more. Bring your own interface; take just the kits you need. Your app keeps its own sign-ins. byokit runs no hosted service.

## A small look at what's possible

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme/reply-dark.png" />
    <img src="docs/readme/reply-light.png" alt="Voice demo after a turn: You and Assistant each say Hello from BYOKit in writing." width="350" />
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme/pair-invitation-dark.png" />
    <img src="docs/readme/pair-invitation-light.png" alt="Pairing demo before connecting: enter the code from your computer, then choose Pair." width="350" />
  </picture>
</p>

**Talk naturally.** Tap to talk, tap again to finish. The [voice example](../examples/realtime-voice) shows listening, thinking, speaking and replies in writing.

**Pair with care.** Compare two words before connecting. The [phone example](../examples/herdr-kit) brings your computer's agents to your phone over an encrypted link.

These are the actual example interfaces in light and dark, not design mockups. The voice capture uses a simulated microphone and an offline voice peer. The pairing capture stops before approval; no agent process is started. No personal account is used.

## Quick start

From a fresh checkout, with **Node 24.16+ on 24.x, or Node 26.1+** and npm installed, run these three steps in the repository root:

**1. Install the workspace.**

```sh
npm ci --no-audit --no-fund
```

**2. Build the kits.**

```sh
npm run build
```

**3. Open the offline voice demo.**

```sh
cd examples/realtime-voice
BYOKIT_EXAMPLE_FAKE=1 \
  node server.ts
```

Open the loopback URL printed in your terminal. Choose **Sign in**, then **Approve sign-in**. Back on the voice screen, tap to talk and tap again to finish. Allow microphone access if asked. Stop the server with **Ctrl+C** when you're done.

No account, API key or paid call is needed. The demo signs in locally and replies with “Hello from BYOKit.” It is an offline demonstration, not proof of a live provider connection. The command above uses a POSIX shell; platform-specific setup is in [Contributing](../CONTRIBUTING.md).

Ready to build your own app? In your app's folder, install only what you use:

```sh
npm install \
  @byokit/accounts \
  @byokit/pair
```

[Sign-in guide](../packages/accounts) · [Pairing guide](../packages/pair) · [All packages](../packages)

## Pick the parts you need

| Build this | Start here |
| :--- | :--- |
| 🔑 **Sign in once** — use a supported AI subscription in your app | [accounts](../packages/accounts) |
| 🤝 **Connect your devices** — pairing, discovery and encrypted relay | [pair](../packages/pair) · [discover](../packages/discover) · [relay](../packages/relay) |
| 🎙️ **Give it a voice** — live conversation, dictation and audio | [realtime](../packages/realtime) · [dictation](../packages/dictation) · [audio](../packages/audio) |
| 🌿 **Know what's left** — plan windows, usage and cost preflight | [usage](../packages/usage) |
| 🧭 **Ask, don't guess** — typed answers with confidence and an option to abstain | [decide](../packages/decide) |
| 🔌 **Reach other apps** — connect a person's online accounts and act over the standard tool protocol | [connect](../packages/connect) · [mcp](../packages/mcp) |
| 🖥️ **Run the helper at home** — an on-device runtime kit and your computer's agents from your phone | [openclaw](../packages/openclaw) · [herdr](../packages/herdr) |
| 📣 **See it on the phone** — screenshots, on-device text generation, signaling and sealed drafts | [browser](../packages/browser) · [infer](../packages/infer) · [signaling](../packages/signaling) · [write](../packages/write) |
| 🧰 **Keep your own look** — sign-in, pairing and consent state without a UI framework | [ui](../packages/ui) |
| 🔒 **Keep private things private** — app-owned secret stores and sealed data | [secrets](../packages/secrets) · [seal](../packages/seal) |
| 🏡 **Bring work home** — runtime connections and on-device capabilities | [Runtime kits](../docs/runtime-kits.md) · [Capability kits](../docs/capability-kits.md) (bubble/overlay, status bar and record: new work in `@platform-kits/overlay`, `@platform-kits/statusbar`, `@platform-kits/record`) |

Each package has its own install command, platform notes and examples. Some kits are still private or awaiting qualification; their package guides say so. [Browse the full collection](../packages).

## Your plan. Honest billing.

**A subscription sign-in is not an API key.** Supported subscription routes use the plan the person already pays for. API-key routes are billed per use and are offered only when your app opts in. Every provider's own terms and limits still apply.

Sign-ins live in your app's chosen storage, not someone else's installed tools. Hosting, relay and remote-computer costs are yours to choose, not a service sold by byokit. See the [account security notes](../packages/accounts/SECURITY.md) and [relay security boundary](../packages/relay/SECURITY.md).

## Keep exploring

- [Vision](../VISION.md): who byokit is for, where it is going and what it is not
- [Web example](../examples/pwa) · [Mobile example](../examples/expo) · [Voice example](../examples/realtime-voice)
- [Runtime kits](../docs/runtime-kits.md) · [Capability kits](../docs/capability-kits.md) (bubble/overlay → `@platform-kits/overlay`; status bar → `@platform-kits/statusbar`; record → `@platform-kits/record`) · [Cloud kit](../docs/cloud-kit.md)
- [Package conventions](../docs/kit-conventions.md) · [Contributing and platform checks](../CONTRIBUTING.md)
- [Releases](https://github.com/umeranjum17/byokit/releases) · [Report a problem](https://github.com/umeranjum17/byokit/issues)

[Apache 2.0](../LICENSE) · [Notices](../NOTICE)
