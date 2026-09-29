# Changelog

## Unreleased

- The accessibility side and publish (docs/capability-kits.md BK-O3): `ByokitAccessibility.attach` now also supplies
  the foreground app (the `accessibility` host applies `rules` and `setRules` over it and keeps `spots: 'per-app'`
  per app) and the keyboard's top (the bubble rests above it). `@byokit/overlay/focused-field` works on Android:
  `available`, `read` (never a password field) and `insert`, which verifies, retries once after 150 ms and otherwise
  copies the text. No longer `private`.
- The bubble (docs/capability-kits.md BK-O2): the native module now runs `start`/`stop` over the `window` host (a
  foreground service with its notice) or the `accessibility` host (`ByokitAccessibility.attach` from the app's own
  service), reports `on`, `off`, `stuck` and `needs-permission`, drags and snaps the bubble to an edge and remembers
  its spot, shows `say` pills, emits `tap`, `longPress`, `moved`, `state` and `panel`, opens the registered panel on
  tap or `openPanel` (hiding the bubble while it is open), and keeps the text-free tap log for 30 days.
- Package layout (docs/capability-kits.md BK-O1): the JS core (types, per-app rules, `createOverlay` with argument
  checks and listener sets, `./focused-field`, words), the Expo module definition with Kotlin stubs, the library
  manifest and the config plugin. The bubble lands in BK-O2 and the focused field in BK-O3; until then the native
  module resolves `off` and rejects the rest with `not built`.
