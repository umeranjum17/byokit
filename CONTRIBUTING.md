# Contributing to byokit

Thanks for helping. byokit is for people who just have a ChatGPT-like subscription: every word a person can see must be
plain (no commands, paths, model ids or error codes), and nothing may touch their other AI tools.

## Setup

Node 22.18 or later.

```sh
npm ci
npm run build   # tsc -b: each package's dist/
npm run check   # tsc over sources and tests, strict
npm test        # every test in a throwaway HOME (outbound network blocked; loopback fakes stay usable), then a byte-for-byte check of your real ~/.pi
npm run test:browser   # the PWA example in headless Chromium (npx playwright install chromium, or BYOKIT_CHROME)
# BYOKIT_CHROME is the one documented key for a test browser: an absolute path or a PATH name of an
# installed Chromium. Unset, the first Chromium on PATH is used; with none, the browser tests skip.
sh scripts/test.sh examples/herdr-kit/e2e.test.ts   # the Herdr kit example, packed, against the fake Herdr
sh scripts/test.sh examples/openclaw-kit/e2e.test.ts   # the OpenClaw kit example, packed, against the fake Gateway
```

Phones: `examples/expo` (`npm ci`, `npm run typecheck`, `npm run bundle` for the iOS and Android bundles, and
`./e2e-android.sh <emulator-serial>` to sign in, ask, decide and pair end to end on an emulator against the stand-in
OpenAI and a link host on this computer).
Include the Android emulator result in the PR. CI builds both platform bundles; iOS is typechecked and bundled, not
runtime-tested here because no simulator is available.
The [realtime Android consumer](examples/realtime-android/README.md) checks lazy
microphone privacy through the native WebRTC bridge against a local stand-in peer.
CI runs it alongside dictation on an emulator; its script refuses physical phones.

## Dependency audit exception

SECURITY (2026-10-02, repository CI policy only): temporarily except exactly
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
There is no patched `node-forge` release; Expo CLI/certificate helpers resolve the
vulnerable RSA signature verifier in both repository and Expo example locks.
[Upstream issue](https://github.com/digitalbazaar/forge/issues/1149) and
[proposed upstream fix](https://github.com/digitalbazaar/forge/pull/1152) track the repair.
**This exception does not fix the vulnerability or make Expo tooling safe.**

Run `node scripts/audit.ts` at the root and `node ../../scripts/audit.ts` from
`examples/expo`, as CI does. The wrapper still runs `npm audit --audit-level=high --json`:
it removes only this advisory's contribution through the reported dependency paths.
Every other high/critical advisory—including a new one in node-forge—still fails;
moderate warnings remain visible. Dependency cycles are valid npm output: every
reachable advisory is counted and each node's severity must be explained. Invalid,
missing, rootless cyclic, inconsistent or unavailable reports and registry/command
errors fail closed. Raw `npm audit` still reports the
unfixed vulnerability. No package-wide allowlist, framework downgrade or fork is used.

Tracking item: **byk-audit-exception-remove**. Recheck the advisory and compatible
node-forge/Expo releases when checkpoint CI resumes and before the next release.
As soon as a fixed compatible release exists, update the affected locks, demonstrate
that raw root and Expo audits no longer contain this advisory, then remove this
exception and its policy text. This is not a fix shipped in release13; its public
SDK tars, dependency pins and existing qualification receipts are unchanged.

SECURITY (2026-10-03, repository CI policy only): also temporarily except exactly
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), npm
`braces`, advisory affected range `<=3.0.3`. The accepted-risk rationale is build-tool
DoS via developer-config glob patterns, no user input, and no patched release.
This is the captain's risk acceptance, **not newly proved complete input safety**;
the retained raw audit and earlier unresolved proof evidence remain unchanged.
The exception fails at **2026-11-02 00:00:00 UTC**, with no silent renewal.
The wrapper retrieves this exact advisory from GitHub's authoritative advisory API;
any non-null `first_patched_version` closes the exception immediately. Retrieval
errors or malformed metadata fail closed. Remove this entry promptly when patched,
and no later than the deadline. Other advisories (including another in braces)
remain subject to the existing high/critical gate. Raw npm audit still reports this
unfixed vulnerability; no dependency override or product artifact fix is implied.

## Rules

- **Isolation first.** byokit never reads or writes a person's `~/.pi`, `~/.codex`, `~/.claude` or cloud credential files,
  never uses their environment's API keys (except the explicitly invoked [live eval CLI](packages/decide#evals)), and
  never runs their CLIs. Runtime kits drive only the aggregator the app names explicitly (the OpenClaw engine the kit
  installs, the Herdr binary and socket the app passes); byokit tests use fakes and never a person's Herdr. Capability
  kits ([docs/capability-kits.md](docs/capability-kits.md)) have their own carve-out: `@byokit/write` may load only
  its exactly pinned public engine package, and `@byokit/record` may spawn only a recorder implementing recorder
  protocol v1 that the app passes by absolute path, or the bundled Linux X11 recorder; their ordinary tests use fakes; the bundled recorder smoke uses an isolated Xvfb.
  Approved exception: the `./cli` entry reads and runs only app-managed per-account folders under `stateDir` and the absolute CLI binaries the app passes; it never touches the person's default login; tokens never leave the device and are never logged.
  Claude usage may read only a managed folder under its passed `stateDir`, without refreshing or writing credentials; expired credentials require sign-in again. Headers are app-passed and tokens never enter readings, stores, errors or logs.
  `@byokit/decide/claude-code` spawns only the unmodified Claude binary the host passes by absolute path,
  in a temporary home and working directory with the separate `CLAUDE_CONFIG_DIR` the host names. The user signs in
  there with the binary itself; the kit never opens or copies credentials, inherits API keys, or falls back to API billing.
  Tests use an offline fake binary.
  `@byokit/usage` reads only the sign-in folder the app passes and spawns only the Codex binary the app passes
  by absolute path, with an environment built from nothing plus what the app passes; its tests use fakes only. `@byokit/bubble` and
  `@byokit/statusbar` and `@byokit/push` run only their own native code inside the app or its notification extension.
  `@byokit/share` runs only its own native code, copies shared content into the app's cache only under the sender's
  grant, and its plugin edits only the generated `settings.gradle`, `build.gradle` and pbxproj. `@byokit/cloud` ([docs/cloud-kit.md](docs/cloud-kit.md)) spawns only the
  `ssh` binary the app passes by absolute path and the `ssh-keyscan` beside it, with the key path the app passes and a
  kit-owned config, and holds only the provider keys the app's store gives it and the scoped keys it mints for that
  app. Its tests use a loopback fake and a fake `ssh`. `@byokit/secrets` uses native OS keyring APIs or spawns
  explicitly selected OS keyring CLIs by absolute path with an environment built from nothing plus only what
  the host passes. `@byokit/browser` starts only the installed Chromium/Chrome the app selects by absolute path,
  with a kit-owned temporary profile and HOME; ordinary tests use fakes and never a person's browser profile.
  Ordinary keyring tests use fakes; real native keyring CI runs in its own disposable OS session. Tests use
  the harness in `packages/accounts/src/testing` (a decoy HOME, an fs tracer, canary
  tokens) and must never need a real account, the network or a model call. `npm test` fails if your own `~/.pi` changed during the run.
- **One package per concern**, small and dependency-light. Prefer deleting to adding.
- **Platform boundary.** See [accounts' platform guide](packages/accounts/README.md#which-sign-in-works-where).
  Its `react-native` and `browser` exports must not import Node modules; computer-only flows belong in the default export.
- Sources are TypeScript that Node runs directly (type stripping): no enums, namespaces or parameter properties, and
  relative imports carry the `.ts` extension.
- Provider terms are data (`packages/accounts/src/catalogue.json`), with a one-line reason and a source. The kit labels
  and never decides for an app. Anthropic Messages uses an app-passed API key (billed per use), with explicit opt-in.
  Approved exception: the `./cli` entry reads and runs only app-managed per-account folders under `stateDir` and the absolute CLI binaries the app passes; it never touches the person's default login; tokens never leave the device and are never logged.
- Plain words live in `words.json` and are tested against a banned-jargon list.
- Pi's `@earendil-works/pi-ai` is pinned exactly. Bump it deliberately, with the isolation tests green.

## Pull requests

One concern per PR, with the checks above passing. By contributing you agree your work is licensed under Apache-2.0.

## Changelog and release notes

Every package has `packages/<pkg>/CHANGELOG.md`, shipped in its tarball, in this format:

```markdown
# Changelog

## Unreleased

- SECURITY: <what was exposed, who is affected, what to do>
- FIX: <what was wrong, what it does now>
- <any other change, one bullet each>

## 0.3.2 (2026-10-01)

- ...
```

- Each entry is a `- ` bullet. It may wrap onto following lines indented by exactly two spaces.
- `SECURITY:` is for anything that exposed a secret, credential, grant or plaintext, or widened what a device
  or app may do. `FIX:` is for correctness bugs a consumer could have hit. Every other change gets a plain
  bullet. Put SECURITY first, then FIX, then the rest.
- An entry that changes what gets billed or which sign-in is used must say "subscription" or
  "API key (billed per use)" explicitly.
- Never name competing products in entries, commits, branches or PR text.
- Version headings are `## <x.y.z>` with an optional ` (<YYYY-MM-DD>)`.
- A PR that changes `packages/<pkg>/src/**` or the `dependencies` of `packages/<pkg>/package.json` adds at
  least one bullet in `packages/<pkg>/changes/<short-unique-slug>.md`. The slug can be the branch name,
  with slashes replaced by hyphens. Use the same bullet syntax and prefixes shown above; a fragment can
  contain multiple bullets. Add a fragment file; do not edit `CHANGELOG.md` directly (CI's `release lint`
  fails the PR otherwise; release PRs that only bump `version` are exempt). The PR body copies every `SECURITY:`/`FIX:` bullet verbatim so
  reviewers see it.

## Releasing

Versions are independent per package (0.x semver): bump minor for new exports, behavior, breaking changes, a
raised engine floor or a pinned runtime upgrade; patch for fixes, shipped-file docs and pin updates from the
cascade. No 1.0, no prereleases, no `major`. Internal `@byokit` pins stay exact, so releasing a package
cascades: published dependents get a patch plus copies of its `SECURITY:`/`FIX:` lines.

Two phases, because publishing happens only from merged main:

1. **prepare** (on a branch, becomes a normal PR): `npm run release -- prepare link=patch relay=minor [--dry-run]`
2. **publish** (on merged main): `npm run release -- publish [--dry-run]`

Publish only publishes versions not yet on npm, so feature PRs keep versions unchanged and their fragments and existing Unreleased changes wait for the next prepare PR.

Publish locally with the machine's npm session (npm's own 2FA prompt comes through; the script never takes
an OTP or token), or dispatch `release.yml` (OIDC trusted publishing with provenance, no stored token) once
the packages' trusted publishers name this repository and workflow file. The first publish of a new package is
local, then `npm trust github` configures its publisher. `private: true` holds a package back (the unfinished
kits); the PR that finishes one removes it.

To relay notes to consumers after a publish:

```sh
npm run -s release -- notes --since <last-relay-timestamp> --json
```

`@byokit/realtime` dials only the engine endpoint the app selects, with the credential the app passes; provider adapters run in kit-owned child processes. Tests use loopback fakes. See [the realtime contract](docs/realtime-kit.md).
