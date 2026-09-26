# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Checks: `npm run build` (tsc -b per package), `npm run check` (tsc over sources and tests) and `npm test` (`scripts/test.sh`: node:test in a throwaway HOME, then a byte-for-byte check of the real `~/.pi`). CI runs all three on Node 22 and 24. Tests never need an account, the network or a model: `mockOpenAI()` (`packages/accounts/src/testing/mock-openai.ts`) stands in for OpenAI's sign-in.
- The TypeScript packages are the product on Node/Electron, browsers/PWA and React Native (iOS, Android). Keep `@byokit/accounts`' browser and React Native export free of runtime Node/Pi imports (`packages/accounts/test/portable.test.ts`); the same holds for `@byokit/link`'s and `@byokit/decide`'s main entries (their `test/react-native.test.ts`). Platform usage is in each package README; checks, including the Android emulator run `examples/expo/e2e-android.sh`, in `CONTRIBUTING.md`.
- Never touch the owner's installed Pi, `~/.pi`, logins, Herdr, muxr or CLIs, in code or tests. Isolation tests use `packages/accounts/src/testing` (decoy HOME, fs tracer, canaries) and Node's `--permission`; see `packages/accounts/test/isolation.test.ts`.
- Sources are TypeScript run directly by Node (type stripping): no enums, namespaces or parameter properties; relative imports carry `.ts`, rewritten by tsc on build. JSON data (`catalogue.json`, `words.json`) is imported with `with { type: 'json' }`.
- `@earendil-works/pi-ai` is pinned exactly in `packages/accounts/package.json`; bump only with the isolation test green. Provider terms are data in `catalogue.json`; Claude plan sign-in is never added.
- `fixtures/README.md` owns conformance scope (including the frozen Kotlin mirror's exception); `packages/accounts/src/{catalogue,words}.json` is the shared data the Kotlin build bundles. Change a rule in the fixture first.
- `android/` is its own Gradle project (byokit-android, the Kotlin mirror, frozen: React Native apps use the TypeScript kit): `android/test.sh [serial]` runs its tests in a throwaway HOME (JDK 17+ in `JAVA_HOME`, `ANDROID_HOME`); CI's `android` job runs it without a device.
- `@byokit/reach` tests run a fake tailscale CLI (`bin` option, PATH set to the fake's dir), a fake mDNS publisher, and a fake zeroconf for the React Native browse API (`src/browse.ts`, injectable; `src/rn.ts` is the only file importing `react-native-zeroconf`, an optional peer the app provides); never the real binary or network.
- `@byokit/decide` never reads an environment variable: the host passes Jev's key to `jev({ key })`; only `byokit-eval --live` reads `TYPESAFE_API_KEY`/`OPENROUTER_API_KEY`. Tests mock `fetch`; eval files replay answers offline.
- Publishing: only from merged main; `.github/workflows/release.yml` offers accounts, ui-core, decide, link, reach and relay via npm trusted publishing with provenance. Changes to published package code bump its version. `@byokit/link`'s muxr parity is tracked separately (parity tests name their checklist row, e.g. `R4:`). `@byokit/link/node` is its only Node-only entry. Its crypto deps are pinned exactly, and its browser tests need Chrome/Chromium (Playwright's, else the system's; skipped locally without one, required in CI). `@byokit/relay` depends on link.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
