# @byokit/usage

Read subscription quota windows per provider and per account on Node 22.18 or later.
The app owns sign-in, token renewal, account labels and selection. The kit reads room
left, estimates no cost and never rotates an account.

```ts
import { usage, roomOf } from '@byokit/usage';
// Supplied by the host's signed-in account.
declare const token: string;
declare const account: { id: string };
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
  and optionally `oauthAccount.accountUuid`. A statusline snapshot uses its body `fetched_at` (epoch milliseconds or ISO date),
  never file mtime. Known snapshots younger than five minutes precede the endpoint;
  undated/future snapshots remain visible with unknown/future age. An expired token is never sent.
- `{ provider: 'claude', accountUuid, read, origin?, connected? }` delegates to the app's
  reader. `read({ nowMs, signal })` returns `{ raw?, code?, retryAfterMs?, at?, limited? }` using
  the same Claude payload dialect. The host supplies the actual observation `at`;
  omitted means unknown age, including engine-cached figures. `limited: true` can
  report an authoritative block without fabricating a window. `origin` is the
  host reader's optional HTTP origin for pacing. It has a ten-second deadline, with the signal
  aborted at expiry. The optional synchronous `connected()` hook controls whether
  last-good readings remain visible; exceptions count as disconnected.

`read(source, { nowMs?, signal? })` returns `{ provider, windows, at?, limited?, poll?, code? }`.
`at` is source observation time; it is absent when unavailable. `poll` contains
last attempt time, `outcome` (`ok` or a safe failure code) and optional `retryAt`.
All timestamps are epoch milliseconds. A failed poll keeps the figures and their
original observation time. Poll 429 (`rate-limited`), host renewal failure
(`refresh-failed`) and credential refusals are distinct; usage never changes
account health or renews credentials.

Windows include kind, optional reported `usedPercent`, duration, reset, limit,
`limited` and `scope: { model?, surface? }`. Missing usage is unknown, never zero.
Claude `limits[]` session/weekly-all rows override corresponding legacy aggregates,
even if incomplete; dynamic weekly-scoped rows retain model and surface. Legacy
`five_hour`/`seven_day` are fallback for absent aggregate kinds. These are synthetic
contract fixtures; fresh live provider payload qualification has not been run.

Parsers are exported: `claudeWindows`, `codexWindows` (app-server),
`codexTokenWindows(raw, nowMs?)`, `codexHardLimit`, `goWindows`, `zaiWindows`,
`copilotWindows`, `grokWindows`, `minimaxWindows`, `geminiWindows`, `kimiWindows`.
Codex absolute reset takes precedence; relative seconds require a captured clock.
Hard flags do not replace the reported percentage or invent an absent window.
Hosts using exported Codex parsers must carry `codexHardLimit(raw)` into the reading
as `limited` to represent windowless blocks.

`roomOf(reading, nowMs)` returns `left`, observation `at?`, `ageMs?`, `freshness`
(`fresh`, `stale`, `future`, `unknown`), `poll?`, and the tightest row's `scope?`.
Numeric results include `span` and optional reset. Authoritative hard blocks give
zero eligibility room even without a percentage/window, with `limited: true`;
a predicted reset never clears a block. Otherwise undated/future/older-than-24h
readings and disconnected/expired/auth/no-plan readings give unknown room.
Incomplete windows cannot establish positive room; known exhaustion still stands.
Scope is conservative across all windows until hosts implement model demand for
every model/surface a run can use, including subagents and fallbacks.
Temporary poll failures may retain eligible last-good room and its age; a poll
failure itself never exhausts or moves an account. Auto's shared input contract is
`fixtures/conformance/usage-typescript.json` and runtime spec section 13.

`connected(source)` and `account(source)` are synchronous. `account` returns a salted
fingerprint of a non-secret host id, credential account UUID, token subject, or explicit
local folder identity. Token subjects provide cache identity only, never authentication.
For opaque tokens and plan keys, pass `accountId` to keep quota history across renewal.
Without it, reads still work in memory, but `account()` is undefined and no public or
disk store is used. Tokens never become persisted fingerprint inputs.

Good reads have no code. Bad sources throw `UsageError` (`code: 'bad-source'`); other
failures resolve codes without bodies or secrets. `lastKnown(source, { nowMs? })`
returns a connected account's last-good figures and most recent poll outcome.
Ordinary dated readings expire after 24 hours; authoritative blocks stay until a
new successful read replaces them. Undated figures remain available for display
with unknown room. Reads have a
60-second floor and concurrent deduplication per provider/account. Default 429
backoff honors Retry-After with a five-minute minimum. Unknown/transient and
refresh failures back off exponentially from one minute to one hour; these are
kit defaults, not universal provider policy. Failure counters are separate by
outcome and account, cleared by a successful quota poll. `UsageOptions.now` supplies
the default clock; a per-call clock overrides it. An injected `fetch` wins; otherwise
global fetch is resolved on each read.

The host may supply public synchronous persistence and backoff hooks:

```ts
import { usage, type UsageStore, type BackoffPolicy } from '@byokit/usage';
declare const appStore: UsageStore;
declare const appBackoff: BackoffPolicy;
const reader = usage({
  store: {
    get(provider, fingerprint) { return appStore.get(provider, fingerprint); },
    put(provider, fingerprint, reading) { appStore.put(provider, fingerprint, reading); },
  },
  backoff: {
    get(provider, fingerprint) { return appBackoff.get(provider, fingerprint); },
    set(provider, fingerprint, untilMs, state) { appBackoff.set(provider, fingerprint, state ?? untilMs); },
    delayMs(retryAfterMs, { outcome, failures }) { return Math.max(300_000, retryAfterMs ?? 0); },
  },
});
```

`UsageStore` holds `{ at?, windows, limited?, poll? }`; only whitelisted normalized fields cross
this boundary. Exceptions from host hooks do not expose data or fail a provider read.
Internal backoff remains effective if a host backoff hook fails. The 60-second
minimum retry interval applies even if a policy selects a shorter delay. By default,
`stateDir` selects an atomic disk store (0700 directory, 0600 file, 256 KB cap), or
without `stateDir` an in-memory store is used. `memoryUsageStore()` is exported.
`store` overrides `stateDir`. Disk storage uses `plans-v2.json`, deliberately ignoring
old raw-payload stores so second-based and millisecond-based readings never mix.
The default salt is `byokit/usage/account`.

To replace a host's Claude quota adapter, pass the exact files the host already
selected. Reuse the backoff policy across collector instances:

```ts
import { usage, fileUsageStore, memoryBackoffPolicy, fingerprint } from '@byokit/usage';
const salt = 'my-app/usage/account';
const store = fileUsageStore('/app/state/usage');
const backoff = memoryBackoffPolicy();
const source = {
  provider: 'claude' as const,
  credentialsFile: '/app/sign-ins/claude/.credentials.json',
  configFile: '/app/sign-ins/claude/.claude.json',
  statuslineFile: '/app/sign-ins/claude/statusline.json',
};
const reader = usage({ store, backoff, salt });
const reading = await reader.read(source);
const lastGood = reader.lastKnown(source);
// For a host-owned non-secret account UUID, this matches reader.account(source).
declare const accountUuid: string;
const accountKey = fingerprint(salt)('claude', accountUuid);
const saved = store.get('claude', accountKey);
```

The kit replaces the credential/snapshot read, quota request, payload parsing,
account fingerprint, last-good disk writes and 429 rest tracking. The host selects
paths and displays the returned windows. A valid recent snapshot precedes the
request; the request uses the kit's own user agent. No credential refresh occurs.
Legacy raw stores require host migration into normalized millisecond readings;
they are never loaded automatically.

`fileUsageStore(absoluteStateDir)` exposes the same bounded atomic disk store as
`stateDir`; invalid directory paths throw `UsageError`. Its keys must be 64-character
hex fingerprints, and it persists only `{ at, windows }` with normalized fields.
`fingerprint(salt)` returns `(provider, nonSecretIdentity) => string`; use the same
salt as the reader and never supply a token as the identity.
`memoryBackoffPolicy()` supplies shared per-provider/account rests, keeps the later
rest when updated, and writes no files. The host can use `retryAfterMs(header, nowMs)`
to parse Retry-After seconds or an HTTP date (invalid/absent values give `undefined`,
past dates clamp to zero), and `backoffDelayMs(retryAfterMs)` to apply the default
five-minute minimum. These helpers also support an app-owned Claude `read` hook
without duplicating fingerprint, persistence or retry logic.

`BackoffPolicy.set(provider, fingerprint, untilMs, state?)` receives a normalized
`state` with `{ untilMs, at, outcome, failures }` on a retryable failure, and zero
eligibility time without state after success. Persist and return that state from
`get` to preserve outcome and retry eligibility across restart. Legacy numeric
`get` values still work; their reason is unavailable when no stored poll supplies it.
`delayMs(retryAfterMs, { outcome, failures })` chooses host policy; a valid server
Retry-After is always a lower bound, alongside the existing one-minute floor.

`UsageOptions.pace({ provider, account, origin, signal })` is an optional async host
hook before each HTTP usage request (including provider discovery/fallback reads).
The host can share an origin-keyed queue across reader instances. Distinct origins
are independent; the kit adds no global queue or fixed origin spacing. Account is
a fingerprint, never a token. Host Claude readers opt in with `source.origin`.
The hook shares the request deadline and can be cancelled by `ReadOptions.signal`;
no request is sent when pacing fails or is cancelled. In-flight duplicate callers
share the first caller's operation/signal. There is no polling timer or inference ping.

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

`tokenLedger({ store?, cap? })` records measured token counts for host member ids.
`record(member, tokens, time)` accepts a nonnegative safe integer and epoch milliseconds;
`query(member, from, to)` uses `[from, to)` bounds and returns total `tokens`, sorted
local-calendar `days: [{ date, tokens }]`, and a `week` ending at `to`. The week spans
seven local calendar days (including DST), independent of `from`, and includes
`{ from, to, tokens, cap?, remaining? }`. Remaining allowance is clamped to zero.
`cap` is a seven-day token count or a synchronous member-to-cap function; omitted
means uncapped. `store` implements `record(member, { tokens, time })` and
`query(member, from, to)`, with `memoryTokenLedgerStore()` as the default. Reuse a
store to keep history across reader instances. The host owns durable storage and
retention; the default ledger never writes files. Invalid inputs and store failures
throw `TokenLedgerError` with `code: 'invalid' | 'store'`, without exposing member ids
or store exception text. Entries are counts only, never sign-in tokens.

`callLedger({ store?, prices? })` records runtime model calls through the same
`TokenLedgerStore` seam. `record(member, { provider, account, model, runId, time,
billing, usage?, payer?, durationMs?, state?, limits? })` returns and stores one
`CallRecord`. `billing` is `subscription` or `api`; `payer` defaults to the member.
`state` is `completed` (default), `cancelled` or `failed`. The host records each
actual model call, including retries, and supplies the provider's final usage when
available. No missing counts are inferred from words or decision sub-answers.

`normalizeTokens(provider, usage)` accepts native usage or its response envelope,
and normalized `{ input?, output?, cachedInput?, cacheWrite?, total? }` counts.
It returns only safe nonnegative integer counts with
`provenance: 'reported' | 'partial' | 'unknown'`. Input includes cache reads/writes,
which are subsets, so total is input plus output once. Claude's distinct cache
buckets are added to ordinary input ([Claude usage fields](https://platform.claude.com/docs/en/build-with-claude/prompt-caching));
OpenAI-compatible input already includes cache ([OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching)).
Gemini output includes candidates and thinking tokens ([Gemini UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata)).
Absent, invalid, explicitly estimated or inconsistent counts remain unknown; raw
response objects, prompts and credential fields are discarded.

Prices are host data keyed by provider then model: `{ billing, currency,
inputPerMillion, outputPerMillion, cachedInputPerMillion?, cacheWritePerMillion? }`.
`priceCall(tokens, price, billing)` and the ledger return a cost only when reported
counts and the matching app price row suffice. No vendor prices are bundled or
fetched. Costs carry `basis: 'app-prices'`, `estimated: true`, and billing labels
`Person's own plan` or `Person's API bill`; an estimate is not an invoice or an
extra charge against a subscription. Missing separate cache rates use the host's
input rate. If a separate rate requires an unknown cache count, cost is unknown.

`query(member, from, to)` returns time-sorted `calls`, aggregate `tokens`, `costs`
separated by currency and billing, and `unpricedCalls`. An aggregate field is
unknown if any call lacks that field. Store implementations must preserve the
entry's optional `call` metadata to replay calls; the default in-memory store does.
Sharing the store lets `tokenLedger.query` count these calls automatically. For
calls with unknown total counts, member/day/week results expose `unknownCalls`,
`tokens` is the known subtotal, and week `remaining` is omitted. Cap and price
policy remain the host's. All times, durations and quota reset timestamps are
milliseconds. There is no transport, credential discovery or automatic rotation.

When passing normalized windows to `@byokit/accounts`' structural helper, use
`roomOf(reading.windows, reading.at, 'milliseconds')`. Its two-argument form is for
legacy reset seconds; normalized usage windows in 0.2.0+ already use milliseconds.
Alternatively, this package's `roomOf(reading, nowMs)` returns a structural `Room`
that the accounts chooser accepts directly. Preserve the original measurement time.
