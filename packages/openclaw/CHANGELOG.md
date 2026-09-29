# Changelog

## Unreleased

- In development (O7): the fake Gateway (`fakeGateway`), the contract suite (`openclawContract`, run by O11) and the
  scripted model (`startModelStub`/`useModelStub`), ported from Crewhouse's test stubs with the script grammar
  unchanged (docs/runtime-kits.md §5.11).
- In development (O1): package scaffold and frozen signatures. Every implementation body refuses with
  `not built: <package id>` until its work package lands (docs/runtime-kits.md §11.2).
