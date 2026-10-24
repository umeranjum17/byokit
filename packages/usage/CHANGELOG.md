# Changelog

## Unreleased

## 0.10.0 (2026-10-24)

- FEAT: `@byokit/usage/version` labels the running version (release, pre-release, or `+dev (dev build)` when unreleased change fragments are present), and `pairLabel` shows an app beside its host (`App 0.2.13 · Host 0.2.10`) with a hint when they differ. `@byokit/usage/version/node` reads it from a `package.json`.

## 0.9.1 (2026-10-18)

- FIX: Codex identity reports safe typed probe failures instead of treating every transport or protocol failure as a missing account; only an explicit null account confirms sign-out.

## 0.9.0 (2026-10-16)

- FEAT: `{ provider: 'cursor', folder }` reads the dashboard's current-period window (`GetCurrentPeriodUsage` on `api2.cursor.sh`) with the token read in process from `<folder>/cursor/auth.json`, parsed to one monthly window (`totalPercentUsed`, resetting at `billingCycleEnd`); the folder must resolve inside the reader's `stateDir` as `<stateDir>/cursor/<hex>`, and a missing or refused reading is `unknown`, never zero.
- FEAT: `{ provider: 'pi', folder, piProvider }` reads the plan the selected Pi provider id names from that folder's own login in `<folder>/auth.json`: `openai-codex` reads ChatGPT's Codex windows (`wham/usage`, addressed by the stored ChatGPT account id or the access token's own claim) and `kimi-coding` reads Kimi's windows (`coding/v1/usages`). The folder must resolve inside the reader's `stateDir` as `<stateDir>/pi/<hex>`; any other Pi provider id is refused as an invalid source, and a missing or refused reading is `unknown`, never zero.

## 0.8.0 (2026-10-12)

- SECURITY: A `credentialsFile`, `configFile` or `statuslineFile` source now refuses, with `UsageError` before any open, any path that carries a `.claude`, `.codex` or `.pi` segment either lexically or once symlinks are resolved, so an app can no longer be pointed at the person's own default sign-in; an app-owned file elsewhere still reads normally, and the segment check is shared with the managed-folder guard.
- FIX: The Codex app-server source no longer opens or reads `<home>/auth.json` to key its account cache; it derives the account fingerprint from the sign-in file's metadata (`dev:ino:size:mtimeMs:ctimeMs`), mirroring the managed Claude folder key. A missing, symlinked or oversized sign-in file falls back to `codex-home\0<home>`. A re-login or a refresh-only rewrite of the file changes that metadata and drops the last-good reading.
- NEW: `preflight(call, { prices, allowance, room })` reports a call's cost ceiling from the app's prices, its billing label, the remaining seven-day token allowance and plan room before the call; it never sends the call, and missing prices, mismatched billing, unbounded output or an invalid price row return an explicit unknown instead of a default rate.
- NEW: `windowsView(reading, nowMs)` (from `@byokit/usage/view`) lists every usage window tightest first, each with its unchanged millisecond `resetsAt`, a `text` line and a `resetText` reset line, plus an as-of age taken only from `Reading.at` ("Read {ago} ago"), "Reading time unknown" without one and no age for a future one. A reading past 24h is marked `stale` while keeping its numbers, and a window without a used percent is reported as unknown.

## 0.7.0 (2026-10-02)

- FIX: Subscription usage views now derive today, activity and people from one account-scoped call snapshot, preserve unknown token counts and distinguish quota polling failures from exhaustion; plan and model labels use plain names.

## 0.6.1 (2026-10-01)

- FIX: Local harness usage had no kit incremental source. Add an explicit-file,
  bounded incremental JSONL source for fixture-qualified
  Pi/OMP, Claude and Codex usage records, with normalized counts, event deduplication,
  partial-line retention and rotation handling. Account, run, route and billing
  attribution remain caller-owned; other harness stores and ccusage extras are unsupported.

## 0.6.0 (2026-10-01)

- FIX: Claude subscription quota snapshots can now be read through an identity-free ephemeral host callback without credentials or a fabricated account UUID; readings never enter a cache or shared store, and retry state stays local to the source.

## 0.5.0 (2026-10-01)

- Add a React Native entry for local call/token ledgers and pure quota helpers; subscription and API key (billed per use) attribution is preserved, with estimates only from app prices.

## 0.4.0 (2026-10-01)



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
