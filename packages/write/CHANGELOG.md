# Changelog

## Unreleased

## 0.1.0 (2026-09-30)

- Initial public release: the typed `Compose` client and `write` agent CLI over the exact npm dependency
  `ownvoice-engine` 0.1.0, speaking protocol 1 with the committed schema and generated wire types.
- Parse voice rules, list platform limits, build brief lines, check drafts and split numbered threads without
  model calls, keys or network access.
- Includes `./testing` with a fake engine and shared contract suite; CI checks the real npm engine in process
  and through its own bin, and the packed install loads it without a source checkout.
