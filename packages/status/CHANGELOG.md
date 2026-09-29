# Changelog

## Unreleased

- First version (docs/capability-kits.md §12, BK-S1): `show`/`clear`/`on`/`state`/`openSettings` over an Expo module
  that posts one promoted ongoing notification on its own low channel, private with a counts-only public copy, a
  timeout re-armed on every post, actions that need the phone unlocked, and a dismissal that sticks until `clear()`.
  Posts are deduped and throttled to one per 1.5 s. The config plugin adds `POST_PROMOTED_NOTIFICATIONS`. iOS and
  Android below 16 report `unsupported`.
