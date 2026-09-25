# Contributing to byokit

Thanks for helping. byokit is for people who just have a ChatGPT-like subscription: every word a person can see must be
plain (no commands, paths, model ids or error codes), and nothing may touch their other AI tools.

## Setup

Node 22.18 or later.

```sh
npm ci
npm run build   # tsc -b: each package's dist/
npm run check   # tsc over sources and tests, strict
npm test        # every test in a throwaway HOME, then a byte-for-byte check of your real ~/.pi
npm run test:browser   # the PWA example in headless Chromium (npx playwright install chromium, or BYOKIT_CHROME)
```

Phones: `examples/expo` (`npm ci`, `npm run typecheck`, `npm run bundle` for the iOS and Android bundles, and
`./e2e-android.sh <emulator-serial>` to sign in end to end on an emulator against the stand-in OpenAI).

## Rules

- **Isolation first.** byokit never reads or writes a person's `~/.pi`, `~/.codex`, `~/.claude` or cloud credential files,
  never uses their environment's API keys (except the explicitly invoked [live eval CLI](packages/decide#evals)), and
  never runs their CLIs. Tests use the harness in `packages/accounts/src/testing` (a decoy HOME, an fs tracer, canary
  tokens) and must never need a real account, the network or a model call. `npm test` fails if your own `~/.pi` changed during the run.
- **One package per concern**, small and dependency-light: `accounts`, `link`, `decide`, `ui-core`. Prefer deleting to adding.
- **Every platform.** The packages run on Node and Electron, in browsers and PWAs, and in React Native on iOS and
  Android. What only a computer can do (files, a loopback listener, Pi's own flows) sits behind the package's default
  export condition; the `react-native` and `browser` side imports no Node module.
- Sources are TypeScript that Node runs directly (type stripping): no enums, namespaces or parameter properties, and
  relative imports carry the `.ts` extension.
- Provider terms are data (`packages/accounts/src/catalogue.json`), with a one-line reason and a source. The kit labels
  and never decides for an app. Claude plan sign-in is never added.
- Plain words live in `words.json` and are tested against a banned-jargon list.
- Pi's `@earendil-works/pi-ai` is pinned exactly. Bump it deliberately, with the isolation tests green.

## Pull requests

One concern per PR, with the checks above passing. By contributing you agree your work is licensed under Apache-2.0.
