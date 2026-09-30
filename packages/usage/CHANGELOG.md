# Changelog

## Unreleased

- Add token quota sources for Claude, Codex, Copilot, Grok, MiniMax, Gemini and Kimi, with BYOKit's own user agent and no credential discovery.
- Add a member-scoped token ledger with local-day totals, trailing seven-day caps and an injectable store (in-memory by default).
- Add `roomOf`; reset timestamps now use epoch milliseconds.
- Add host Claude reader, last-good store and 429 backoff hooks. Persist only normalized quota fields and fingerprint non-secret identities.

## 0.2.0 (2026-09-30)

- Add token quota sources for Claude, Codex, Copilot, Grok, MiniMax, Gemini and Kimi, with BYOKit's own user agent and no credential discovery.
- Add a member-scoped token ledger with local-day totals, trailing seven-day caps and an injectable store (in-memory by default).
- Add `roomOf`; reset timestamps now use epoch milliseconds.
- Add host Claude reader, last-good store and 429 backoff hooks. Persist only normalized quota fields and fingerprint non-secret identities.

## 0.1.0

- Read subscription usage windows per provider and per account, with last-good readings and bounded provider reads.
