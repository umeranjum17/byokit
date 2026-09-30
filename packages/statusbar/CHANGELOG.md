# Changelog

## Unreleased

## 0.1.0 (2026-09-30)

- Proven on Android emulators (BK-S1): on API 36.1 the chip shows, the lock screen shows only the public copy,
  the expanded notification has three actions and a swiped-away notification is not posted again until `clear()`;
  on API 35 `state()` is `unsupported` and `show()` posts nothing. No longer `private`.
- First version (docs/capability-kits.md §12, BK-S1): `show`/`clear`/`on`/`state`/`openSettings` over an Expo module
  that posts one promoted ongoing notification on its own low channel, private with a counts-only public copy, a
  timeout re-armed on every post, actions that need the phone unlocked, and a dismissal that sticks until `clear()`.
  Posts are deduped and throttled to one per 1.5 s. The config plugin adds `POST_PROMOTED_NOTIFICATIONS`. iOS and
  Android below 16 report `unsupported`.
