# Changelog

## Unreleased

- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.
- FIX: `OpenClawKit.call()` before `start()` returns a rejected promise (`gateway not ready`) instead of throwing synchronously.

- In development (O7): the fake Gateway (`fakeGateway`), the contract suite (`openclawContract`, run by O11) and the
  scripted model (`startModelStub`/`useModelStub`), ported from Crewhouse's test stubs with the script grammar
  unchanged (docs/runtime-kits.md §5.11).
- In development (O1): package scaffold and frozen signatures. Every implementation body refuses with
  `not built: <package id>` until its work package lands (docs/runtime-kits.md §11.2).
