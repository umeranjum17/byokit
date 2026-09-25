# byokit

Bring your own AI plan and devices. Apache-2.0.

| Package | What it does | State |
|---|---|---|
| [`@byokit/accounts`](packages/accounts) | Sign in with the AI plan you already pay for, into your app's own store; limits, refresh, plain words. Node, Electron, browsers and PWAs, React Native on iOS and Android | [version](packages/accounts/package.json) |
| [`@byokit/ui-core`](packages/ui-core) | Headless sign-in and pairing state for any UI (React, React Native, or none): phases, QR, consent, link words, route labels | [version](packages/ui-core/package.json) |
| [`@byokit/link`](packages/link) | Scan a code to pair a phone or browser with the home computer over one encrypted link, with device stores for phones, browsers and computers; muxr parity tracked separately | [version](packages/link/package.json) |
| [`@byokit/relay`](packages/relay) | Routes encrypted link frames; enrolment, typed-code lookup, push ([security boundary](packages/relay/SECURITY.md)) | [version](packages/relay/package.json) |
| [`@byokit/reach`](packages/reach) | Node only: the addresses a phone dials the home computer on (Tailscale Serve, direct tailnet, LAN) and mDNS advertising | [version](packages/reach/package.json) |
| [`@byokit/decide`](packages/decide) | Typed questions in, a typed answer with confidence out, abstaining below a floor; rules, Jev or any model (the person's own ChatGPT on a phone), evals | [version](packages/decide/package.json) |

Examples: [`examples/expo`](examples/expo) (React Native, iOS and Android) and [`examples/pwa`](examples/pwa)
(an installable web page). For platform checks and their limits, see [CONTRIBUTING.md](CONTRIBUTING.md).

byokit never touches a person's other AI tools: not their `~/.pi`, `~/.codex` or `~/.claude`, not their CLIs.
Library code never reads environment keys; the explicitly invoked [decide eval CLI](packages/decide#evals) can use one
for a live run. The tests prove isolation; see [CONTRIBUTING.md](CONTRIBUTING.md).
