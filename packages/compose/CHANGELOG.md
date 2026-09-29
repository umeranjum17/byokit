# Changelog

## Unreleased

- Scaffold (docs/capability-kits.md BK-0): frozen public types, the `Compose` client, engine seams, the `compose`
  CLI, `./testing` and words. Bodies throw `not built` until BK-P1 (client, CLI, fake engine, contract) and BK-P2
  (the pinned engine) land.
- BK-P1 (docs/capability-kits.md §9.2): the `Compose` client (version gate, validation, error mapping), `checkLines`,
  the `compose` CLI, the fake engine and the contract suite, with `test/{compose,words,cli,fake,contract}.test.ts`.
