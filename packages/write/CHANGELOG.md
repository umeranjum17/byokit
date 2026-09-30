# Changelog

## Unreleased

- Scaffold (docs/capability-kits.md BK-0): frozen public types, the `Compose` client, engine seams, the `compose`
  CLI, `./testing` and words. Bodies throw `not built` until BK-P1 (client, CLI, fake engine, contract) and BK-P2
  (the pinned engine) land.
- BK-P1 (docs/capability-kits.md §9.2): the `Compose` client (version gate, validation, error mapping), `checkLines`,
  the `compose` CLI, the fake engine and the contract suite, with `test/{compose,words,cli,fake,contract}.test.ts`.
- BK-P2 (docs/capability-kits.md §9.2): `inProcessEngine()` and `binEngine()` over the engine's protocol 1 wire (flat
  requests, `hello` outside the schema); the committed schema `schema/engine-protocol-1.json` pinned by
  `ENGINE_SCHEMA_SHA256`, `ENGINE_VERSION` 0.1.0 and generated wire types (`src/generated/protocol.ts`); contract case 6
  allows the engine's `<n>/<m> ` post counter. Still private until `ownvoice-engine` is on npm.
