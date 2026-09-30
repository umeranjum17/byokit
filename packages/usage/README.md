# @byokit/usage

Read subscription quota windows per provider and per account on Node 22.18 or later.
The app owns sign-in, token renewal, account labels and selection. The kit reads room
left, estimates no cost and never rotates an account.

```ts
import { usage, roomOf } from '@byokit/usage';
const reader = usage({ stateDir: '/app/state/usage' });
const source = { provider: 'codex' as const, access: token, accountId: account.id };
const reading = await reader.read(source);
const room = roomOf(reading, Date.now());
```

Sources:

- `{ provider: 'codex', access, accountId }` reads ChatGPT's `wham/usage`.
- `{ provider: 'claude', access, accountUuid?, accountId? }` reads Claude plan usage.
- `{ provider: 'copilot' | 'grok' | 'minimax' | 'kimi', access, accountId? }` reads
  the corresponding subscription quota. MiniMax's `access` is the plan key.
- `{ provider: 'gemini', access, project?, accountId? }` reads Code Assist quota.
  Without a project, the kit discovers it through `loadCodeAssist` first.
- `{ provider: 'opencode' | 'zai', key, accountId? }` reads plan-key quota.
- `{ provider: 'codex', bin, home, env? }` retains the explicit local app-server source.
- `{ provider: 'claude', credentialsFile, configFile?, statuslineFile? }` is a
  read-only adapter for files the app explicitly supplies. It reads `claudeAiOauth`
  and optionally `oauthAccount.accountUuid`. A valid statusline snapshot younger
  than five minutes precedes the endpoint. An expired token is never sent.
- `{ provider: 'claude', accountUuid, read, connected? }` delegates to the app's
  reader. `read({ nowMs, signal })` returns `{ raw?, code?, retryAfterMs? }` using
  the same Claude payload dialect. It has a ten-second deadline, with the signal
  aborted at expiry. The optional synchronous `connected()` hook controls whether
  last-good readings remain visible; exceptions count as disconnected.

`read(source, { nowMs? })` returns `{ provider, windows, at, code? }`; `at` and all
`resetsAt` fields are **epoch milliseconds** in 0.2.0. This changes 0.1.0's seconds
reset convention. Windows include kind, used percent, optional duration in minutes,
reset time, limit label and limited flag. Parsers are exported for host integrations:
`claudeWindows`, `codexWindows` (app-server), `codexTokenWindows`, `goWindows`,
`zaiWindows`, `copilotWindows`, `grokWindows`, `minimaxWindows`, `geminiWindows`,
`kimiWindows(raw, nowMs)`.

`roomOf(reading, nowMs)` returns `{ left, span, resetsAt?, at }` using the tightest
window. Span maps session/week/month and maps rolling/custom to `tightest`. Missing
windows, readings older than 24 hours, future readings, or disconnected/expired/auth/
no-plan readings give `{ left: 'unknown', at }`. A temporary rate limit or failed
update can still show the last-good room and its original timestamp. Auto selection
belongs to the accounts kit; usage only reports room.

`connected(source)` and `account(source)` are synchronous. `account` returns a salted
fingerprint of a non-secret host id, credential account UUID, token subject, or explicit
local folder identity. Token subjects provide cache identity only, never authentication.
For opaque tokens and plan keys, pass `accountId` to keep quota history across renewal.
Without it, reads still work in memory, but `account()` is undefined and no public or
disk store is used. Tokens never become persisted fingerprint inputs.

Good reads have no code. Bad sources throw `UsageError` (`code: 'bad-source'`); other
failures resolve codes without bodies or secrets. `lastKnown(source, { nowMs? })`
returns a connected account's last-good reading for up to 24 hours. Reads have a
60-second floor and concurrent deduplication per provider/account. The default 429
backoff honors Retry-After with a five-minute minimum. `UsageOptions.now` supplies
the default clock; a per-call clock overrides it. An injected `fetch` wins; otherwise
global fetch is resolved on each read.

The host may supply public synchronous persistence and backoff hooks:

```ts
const reader = usage({
  store: {
    get(provider, fingerprint) { return appStore.get(provider, fingerprint); },
    put(provider, fingerprint, reading) { appStore.put(provider, fingerprint, reading); },
  },
  backoff: {
    get(provider, fingerprint) { return appBackoff.get(provider, fingerprint); },
    set(provider, fingerprint, untilMs) { appBackoff.set(provider, fingerprint, untilMs); },
    delayMs(retryAfterMs) { return Math.max(300_000, retryAfterMs ?? 0); },
  },
});
```

`UsageStore` holds only `{ at, windows }`; only whitelisted normalized fields cross
this boundary. Exceptions from host hooks do not expose data or fail a provider read.
Internal 429 backoff remains effective if a host backoff hook fails. The 60-second
minimum retry interval applies even if a policy selects a shorter delay. By default,
`stateDir` selects an atomic disk store (0700 directory, 0600 file, 256 KB cap), or
without `stateDir` an in-memory store is used. `memoryUsageStore()` is exported.
`store` overrides `stateDir`. Disk storage uses `plans-v2.json`, deliberately ignoring
old raw-payload stores so second-based and millisecond-based readings never mix.
The default salt is `byokit/usage/account`.

Isolation: there is no home/path discovery or environment read. Only absolute files
and the Codex binary explicitly supplied by the app are opened/run. Credential files
are bounded regular files, with final symlinks rejected. The spawn uses argv and an
environment built from the host's explicit `env` plus `CODEX_HOME=home`; pass PATH
and HOME explicitly when needed. No tokens in logs, errors, readings or public hooks;
no credential write-back, telemetry, automatic refresh or reset-credit spend.

Built-in requests send `User-Agent: byokit/usage/0.2.0`, never another app's identity.
A refusal returns a code; with no last-good quota, room is unknown. Fixed endpoints
are Anthropic `api/oauth/usage`, ChatGPT `backend-api/wham/usage`, GitHub
`copilot_internal/user`, Grok `v1/billing` (weekly credits then monthly when needed),
MiniMax `v1/token_plan/remains`, Gemini `v1internal:retrieveUserQuota`, Kimi
`coding/v1/usages`, OpenCode `zen/go/v1/usage`, and z.ai `monitor/usage/quota/limit`.
HTTP requests reject redirects, have a ten-second deadline and a 64 KB body cap.
Claude includes `anthropic-beta: oauth-2025-04-20`; Codex includes the host's
`ChatGPT-Account-Id`. Codex app-server reads have a twenty-second deadline, a 64 KB
stdout cap and SIGTERM followed by SIGKILL after one second.

The Node-only main entry also exports `UsageError`, types, `words` and `usageWords`.
`./testing` exports `fakeFetch`, `fakeCodex` and `usageContract(make, { test? })`.
Tests use synthetic recorded protocol shapes and fakes behind the repository's
network guard. They never open real sign-ins or call provider endpoints.
