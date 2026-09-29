# Changelog

## Unreleased

- Package layout (docs/capability-kits.md BK-O1): the JS core (types, per-app rules, `createOverlay` with argument
  checks and listener sets, `./focused-field`, words), the Expo module definition with Kotlin stubs, the library
  manifest and the config plugin. The bubble lands in BK-O2 and the focused field in BK-O3; until then the native
  module resolves `off` and rejects the rest with `not built`.
