# Changelog

## Unreleased

## 0.3.0 (2026-10-24)

- Dependency update: pins @byokit/usage 0.10.0.

- FEAT: `write --version` prints the running version, and `write --help` starts with it; a build with unreleased changes says `+dev (dev build)`.

## 0.2.1 (2026-10-17)

- README install no longer pins a stale version; it installs the current release.

## 0.2.0 (2026-10-01)

- FIX: React Native now selects a portable `Compose` entry with a required app-supplied engine and no Node imports.
  The explicit `./portable` entry uses the same validation and protocol 1 gate; the Node default and CLI are preserved.
- FIX: Writing errors preserve their class identity when compiled to ES5 for Hermes.

## 0.1.0 (2026-09-30)

- Initial public release: the typed `Compose` client and `write` agent CLI over the exact npm dependency
  `ownvoice-engine` 0.1.0, speaking protocol 1 with the committed schema and generated wire types.
- Parse voice rules, list platform limits, build brief lines, check drafts and split numbered threads without
  model calls, keys or network access.
- Includes `./testing` with a fake engine and shared contract suite; CI checks the real npm engine in process
  and through its own bin, and the packed install loads it without a source checkout.
