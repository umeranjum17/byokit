# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Checks: `npm run build` (tsc -b per package), `npm run check` (tsc over sources and tests) and `npm test` (`scripts/test.sh`: node:test in a throwaway HOME, then a byte-for-byte check of the real `~/.pi`). CI runs all three on Node 22 and 24. Tests never need an account, the network or a model.
- Never touch the owner's installed Pi, `~/.pi`, logins, Herdr, muxr or CLIs, in code or tests. Isolation tests use `packages/accounts/src/testing` (decoy HOME, fs tracer, canaries) and Node's `--permission`; see `packages/accounts/test/isolation.test.ts`.
- Sources are TypeScript run directly by Node (type stripping): no enums, namespaces or parameter properties; relative imports carry `.ts`, rewritten by tsc on build. JSON data (`catalogue.json`, `words.json`) is imported with `with { type: 'json' }`.
- `@earendil-works/pi-ai` is pinned exactly in `packages/accounts/package.json`; bump only with the isolation test green. Provider terms are data in `catalogue.json`; Claude plan sign-in is never added.
- `fixtures/conformance/*.json` holds the cases every implementation must pass (see `fixtures/README.md`); `packages/accounts/src/{catalogue,words}.json` is the one copy of the shared data, which the Kotlin build bundles too. Change a rule in the fixture first.
- `android/` is its own Gradle project (byokit-android, the Kotlin mirror): `android/test.sh [serial]` runs its tests in a throwaway HOME (JDK 17+ in `JAVA_HOME`, `ANDROID_HOME`); CI's `android` job runs it without a device.
- `@byokit/decide` never reads an environment variable: the host passes Jev's key to `jev({ key })`; only `byokit-eval --live` reads `TYPESAFE_API_KEY`/`OPENROUTER_API_KEY`. Tests mock `fetch`; eval files replay answers offline.
- Publishing: `.github/workflows/release.yml` (npm trusted publishing with provenance). `@byokit/decide` is not in its options yet (the token lacks the `workflow` scope), so it is published with `npm publish -w @byokit/decide`. `@byokit/link` is a placeholder and is not published.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
