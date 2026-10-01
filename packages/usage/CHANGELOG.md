# Changelog

## Unreleased

- SECURITY: Claude subscription usage may read credentials only from app-managed folders under the passed stateDir, without refresh or credential writes; default logins and folder escapes are refused, tokens stay in one request and never enter output, errors, logs or stored readings.
- Share the bounded Codex app-server client between identity and subscription usage reads.
- Apply shared poll health, scoped quota and hard-limit semantics to managed Claude usage, including cancellable host pacing.
- Add host lane/route attribution and member-scoped per-run token queries to `callLedger`, sharing existing limits and app-owned cap policy.
- Accept OpenClaw run usage with separate cache buckets alongside accounts and decide results, without provider calls or logging. Subscription attribution defaults on; API key (billed per use) attribution stays explicit and labelled.

## 0.3.0 (2026-10-01)



- FIX: Subscription hard-limit flags now override positive percentage room, including blocks without quota windows; cached reset times never clear them.
- FIX: Claude subscription normalized and scoped quota rows now take precedence over legacy aggregates; missing usage remains unknown.
- Expose observation age and poll outcomes separately; retain last-good figures through failed polls without changing account health.
- Add cancellable host origin pacing and account-scoped retry policies for rate limits, refresh failures and transient outcomes.
- Document reset-time units when passing normalized subscription readings to account selection.

## 0.2.0 (2026-09-30)



- Export `fingerprint`, `fileUsageStore`, `memoryBackoffPolicy`, `retryAfterMs` and `backoffDelayMs` for host subscription usage adapters.
- Add token quota sources for Claude, Codex, Copilot, Grok, MiniMax, Gemini and Kimi, with BYOKit's own user agent and no credential discovery.
- Add `callLedger`, `normalizeTokens` and `priceCall` for attributed model calls, reported/partial/unknown counts and estimates from app price tables only, on the member ledger store seam.
- Add a member-scoped token ledger with local-day totals, trailing seven-day caps and an injectable store (in-memory by default).
- Add `roomOf`; reset timestamps now use epoch milliseconds.
- Add host Claude reader, last-good store and 429 backoff hooks. Persist only normalized quota fields and fingerprint non-secret identities.
- Read subscription usage windows per provider and per account, with last-good readings and bounded provider reads.

## 0.1.0

- Read subscription usage windows per provider and per account, with last-good readings and bounded provider reads.
