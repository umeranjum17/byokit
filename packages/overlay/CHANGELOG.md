# Changelog

## Unreleased

## 0.2.1 (2026-09-30)

- FIX: Text insertion no longer gives up while the panel is closing; it retries unreadable fields and only
  re-acquires a field with the same view id, bounds and package.

## 0.2.0 (2026-09-30)

- Focused-field insert options (docs/capability-kits.md 7.4): `insert` takes `{ attempts, retryMs,
  acceptNewlineLoss }` (defaults 2 tries of 150 ms; a panel on top needs ~13 in Chrome) and resolves
  `'landedWithoutNewlines'` when a contenteditable dropped only the newlines. The field is the focused node itself
  when editable, else the first editable non-password focused descendant, and `FocusedFields` exposes the same
  search, read and insert to Kotlin, so the app's service inserts into the captured node with no JS running.
- Bubble TalkBack support: a label (`label` in `start`, `setLabel`, cleared with `null`) and an `announce` option
  for `say` that reads the pill aloud.
- Kotlin-driven bubble: public `Rules.shows(app)` (the per-app decision in Kotlin) and `ServiceBubble`, which the
  app's service starts once with its persisted rules so the bubble shows on attach and restores after a reboot or
  process death.

## 0.1.0 (2026-09-29)

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
