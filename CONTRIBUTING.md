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
sh scripts/test.sh examples/herdr-kit/e2e.test.ts   # the Herdr kit example, packed, against the fake Herdr
```

Phones: `examples/expo` (`npm ci`, `npm run typecheck`, `npm run bundle` for the iOS and Android bundles, and
`./e2e-android.sh <emulator-serial>` to sign in, ask, decide and pair end to end on an emulator against the stand-in
OpenAI and a link host on this computer).
Include the Android emulator result in the PR. CI builds both platform bundles; iOS is typechecked and bundled, not
runtime-tested here because no simulator is available.

## Rules

- **Isolation first.** byokit never reads or writes a person's `~/.pi`, `~/.codex`, `~/.claude` or cloud credential files,
  never uses their environment's API keys (except the explicitly invoked [live eval CLI](packages/decide#evals)), and
  never runs their CLIs. Runtime kits drive only the aggregator the app names explicitly (the OpenClaw engine the kit
  installs, the Herdr binary and socket the app passes); byokit tests use fakes and never a person's Herdr. Capability
  kits ([docs/capability-kits.md](docs/capability-kits.md)) have their own carve-out: `@byokit/compose` may load only
  its exactly pinned public engine package, and `@byokit/capture` may spawn only a recorder implementing recorder
  protocol v1 that the app passes by absolute path; their `npm test` runs use fakes only. `@byokit/overlay` runs only
  its own native code inside the app. Tests use
  the harness in `packages/accounts/src/testing` (a decoy HOME, an fs tracer, canary
  tokens) and must never need a real account, the network or a model call. `npm test` fails if your own `~/.pi` changed during the run.
- **One package per concern**, small and dependency-light. Prefer deleting to adding.
- **Platform boundary.** See [accounts' platform guide](packages/accounts/README.md#which-sign-in-works-where).
  Its `react-native` and `browser` exports must not import Node modules; computer-only flows belong in the default export.
- Sources are TypeScript that Node runs directly (type stripping): no enums, namespaces or parameter properties, and
  relative imports carry the `.ts` extension.
- Provider terms are data (`packages/accounts/src/catalogue.json`), with a one-line reason and a source. The kit labels
  and never decides for an app. Claude plan sign-in is never added.
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
  least one bullet under that package's `## Unreleased` (CI's `release lint` fails the PR otherwise; release
  PRs that only bump `version` are exempt). The PR body copies every `SECURITY:`/`FIX:` bullet verbatim so
  reviewers see it.

## Releasing

Versions are independent per package (0.x semver): bump minor for new exports, behavior, breaking changes, a
raised engine floor or a pinned runtime upgrade; patch for fixes, shipped-file docs and pin updates from the
cascade. No 1.0, no prereleases, no `major`. Internal `@byokit` pins stay exact, so releasing a package
cascades: published dependents get a patch plus copies of its `SECURITY:`/`FIX:` lines.

Two phases, because publishing happens only from merged main:

1. **prepare** (on a branch, becomes a normal PR): `npm run release -- prepare link=patch relay=minor [--dry-run]`
2. **publish** (on merged main): `npm run release -- publish [--dry-run]`

Publish locally with the machine's npm session (npm's own 2FA prompt comes through; the script never takes
an OTP or token), or dispatch `release.yml` (OIDC trusted publishing with provenance, no stored token) once
the packages' trusted publishers name this repository and workflow file. The first publish of a new package is
local, then `npm trust github` configures its publisher. `private: true` holds a package back (the unfinished
kits); the PR that finishes one removes it.

To relay notes to consumers after a publish:

```sh
npm run -s release -- notes --since <last-relay-timestamp> --json
```
