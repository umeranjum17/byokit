# byokit

Bring your own AI plan and devices. Apache-2.0.

| Package | What it does | State |
|---|---|---|
| [`@byokit/accounts`](packages/accounts) | Sign in with the AI plan you already pay for, into your app's own store; limits, refresh, plain words. Node, Electron, browsers and PWAs, React Native on iOS and Android | v0.2 |
| [`@byokit/ui-core`](packages/ui-core) | Headless sign-in state for any UI (React, React Native, or none) | v0.1 |
| [`@byokit/link`](packages/link) | Scan a code to pair a phone or browser with the home computer over one encrypted link; muxr parity tracked separately | 0.1.0 |
| [`@byokit/decide`](packages/decide) | Typed questions in, a typed answer with confidence out, abstaining below a floor; rules and Jev backends, evals | v0.1 |

Examples: [`examples/expo`](examples/expo) (React Native, iOS and Android) and [`examples/pwa`](examples/pwa)
(an installable web page). The PWA signs in end to end against a stand-in OpenAI in browser tests. Run
`examples/expo/e2e-android.sh <emulator>` locally for Android emulator sign-in evidence and include the result in the PR;
CI checks both platform bundles. iOS is typechecked and built, not runtime-tested here because no simulator is available.

byokit never touches a person's other AI tools: not their `~/.pi`, `~/.codex` or `~/.claude`, not their CLIs.
Library code never reads environment keys; the explicitly invoked [decide eval CLI](packages/decide#evals) can use one
for a live run. The tests prove isolation; see [CONTRIBUTING.md](CONTRIBUTING.md).
