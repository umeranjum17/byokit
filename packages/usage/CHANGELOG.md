# Changelog

## Unreleased

- Export `fingerprint`, `fileUsageStore`, `memoryBackoffPolicy`, `retryAfterMs` and `backoffDelayMs` for host subscription usage adapters.
- Add token quota sources for Claude, Codex, Copilot, Grok, MiniMax, Gemini and Kimi, with BYOKit's own user agent and no credential discovery.
- Add `callLedger`, `normalizeTokens` and `priceCall` for attributed model calls, reported/partial/unknown counts and estimates from app price tables only, on the member ledger store seam.
- Add a member-scoped token ledger with local-day totals, trailing seven-day caps and an injectable store (in-memory by default).
- Add `roomOf`; reset timestamps now use epoch milliseconds.
- Add host Claude reader, last-good store and 429 backoff hooks. Persist only normalized quota fields and fingerprint non-secret identities.
- Read subscription usage windows per provider and per account, with last-good readings and bounded provider reads.

## 0.1.0

- Read subscription usage windows per provider and per account, with last-good readings and bounded provider reads.
