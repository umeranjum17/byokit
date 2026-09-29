# Changelog

## Unreleased

- SECURITY: the operator install policy blocks any skill request whose kind contains `depend` (e.g. `skill-dependency-install`) even under an own root; previously only `installSpec` installer fields were checked.
- FIX: the trusted-skill version check uses `request.origin.version` when present and falls back to the `SKILL.md` frontmatter version, so reviewed bundled skills without a frontmatter version match their trusted entry.
- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.
- FIX: `OpenClawKit.call()` before `start()` returns a rejected promise (`gateway not ready`) instead of throwing synchronously.
- The bridge no longer keys behavior on the plugin id: `KitOptions.bridge` (`socketName`, `paramPrefix`,
  validated, defaulting to `bridge.sock` / `__byokit`) replaces the `crewhouse` special-cases, and
  `startModelStub` takes a configurable `idPattern` and routing marker instead of a fixed prompt grammar
  (docs/runtime-kits.md §§5.5/5.9; adopting apps pass their own values explicitly).

- In development (O7): the fake Gateway (`fakeGateway`), the contract suite (`openclawContract`, run by O11) and the
  scripted model (`startModelStub`/`useModelStub`), ported from Crewhouse's test stubs with the script grammar
  unchanged (docs/runtime-kits.md §5.11).
- In development (O1): package scaffold and frozen signatures. Every implementation body refuses with
  `not built: <package id>` until its work package lands (docs/runtime-kits.md §11.2).
