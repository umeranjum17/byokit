# @byokit/usage

Read subscription quota windows per provider and per account on Node 22.18 or later.
React Native also supports local call/token accounting and pure quota parsing.
The app owns sign-in, token renewal, account labels and selection. The kit reads room
left, estimates cost only from app-supplied prices and never rotates an account.

```ts
import { usage, roomOf } from '@byokit/usage';
const reader = usage({ stateDir: '/app/state/usage' });
// Pass the token and account id from your app-owned sign-in store.
declare const token: string;
declare const account: { id: string };
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
- `{ provider: 'claude', ephemeral: true, read, connected? }` supports a host-owned
  opaque snapshot stream without an account UUID, email, folder or token. The same
  `ClaudeReader` answer and ten-second cancellable deadline apply. For a statusline
  body, return `{ raw: snapshot, at: snapshot.fetched_at }` when the host knows that
  `fetched_at` is epoch milliseconds; otherwise omit `at` for unknown age. The kit
  normalizes `rate_limits` and quota rows; it never opens a snapshot or credential
  file, discovers credentials, copies tokens or makes a fallback request.
  `connected()` should reflect the host's sign-in status; false or a thrown error
  returns `not-connected`. An absent/invalid snapshot returns `incomplete`, while
  timeout/cancellation returns `unavailable`; the host can report other safe codes.
  `account()` and `lastKnown()` always return undefined. Successful readings are
  never retained, so each subsequent read invokes the callback again. Only retry
  metadata and concurrent operations are weakly held per source object in this
  reader: reuse an immutable source for one stream, and replace it when the host
  changes sign-in or stream. Failures never return earlier quota figures.
  Rate limits honor Retry-After with a five-minute default; transient failures use
  exponential backoff from one minute, capped at one hour. `backoff.delayMs` may
  customize these delays with a one-minute minimum. Store and backoff get/set
  hooks and account-based pacing are never called; the host owns any pacing in
  its callback. No state is shared between source objects or reader instances.

`read(source, { nowMs?, signal? })` returns `{ provider, windows, at?, limited?, poll?, code? }`.
`at` is source observation time; it is absent when unavailable. `poll` contains
last attempt time, `outcome` (`ok` or a safe failure code) and optional `retryAt`.
All timestamps are epoch milliseconds. A failed poll keeps the figures and their
original observation time. Poll 429 (`rate-limited`), host renewal failure
(`refresh-failed`) and credential refusals are distinct; usage never changes
account health or renews credentials.

The managed-folder source is `{ provider: 'claude', folder, headers: { 'anthropic-beta', 'User-Agent' } }`. Paths must be absolute; removed or empty keys mean disconnected. Claude headers are app-passed. The Claude folder must resolve inside the reader's `stateDir` as `<stateDir>/claude/<hex>`, matching managed CLI account folders. Default `.claude` roots, paths outside the root, and symlinked folders or credential files are refused. Use the managed plans root as the usage reader's stateDir; its quota store coexists with the account roster. The default login's usage adapter remains with the host.

Approved exception: the `./cli` entry reads and runs only app-managed per-account folders under `stateDir` and the absolute CLI binaries the app passes; it never touches the person's default login; tokens never leave the device and are never logged. Under the same managed-folder boundary, usage may read `.credentials.json` only for a single Claude subscription usage request. It does not refresh, write, rename or copy credentials; expired or malformed credentials return `expired` or `not-connected`, requiring sign-in again. The token is held in memory only for that request and never enters readings, stored quotas, errors or logs. Folder and credential metadata supply the cache fingerprint without loading a token, and credential changes invalidate the cached account reading.

`read(source, { nowMs? })` returns `{ provider, windows, at, code? }`; `at` and all
`resetsAt` fields are **epoch milliseconds** in 0.2.0. This changes 0.1.0's seconds
reset convention. Windows include kind, used percent, optional duration in minutes,
reset time, limit label and limited flag. Parsers are exported for host integrations:
`claudeWindows`, `codexWindows` (app-server), `codexTokenWindows`, `goWindows`,
`zaiWindows`, `copilotWindows`, `grokWindows`, `minimaxWindows`, `geminiWindows`,
`kimiWindows(raw, nowMs)`.

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
import { usage, type UsageStore, type BackoffState } from '@byokit/usage';
// Replace these maps with your app's durable store to retain state across restart.
const appStore: UsageStore = {
  get(provider, fingerprint) { return saved.get(`${provider}/${fingerprint}`); },
  put(provider, fingerprint, reading) { saved.set(`${provider}/${fingerprint}`, reading); },
};
const saved = new Map<string, import('@byokit/usage').StoredReading>();
const appBackoff = new Map<string, BackoffState | number>();
const reader = usage({
  store: {
    get(provider, fingerprint) { return appStore.get(provider, fingerprint); },
    put(provider, fingerprint, reading) { appStore.put(provider, fingerprint, reading); },
  },
  backoff: {
    get(provider, fingerprint) { return appBackoff.get(`${provider}/${fingerprint}`); },
    set(provider, fingerprint, untilMs, state) { appBackoff.set(`${provider}/${fingerprint}`, state ?? untilMs); },
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
hex fingerprints, and it persists normalized observations, hard blocks and poll metadata.
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

Built-in requests send `User-Agent: byokit/usage/0.3.0`, never another app's identity.

Token and explicit-file sources send `User-Agent: byokit/usage/0.2.0`, never another app's identity.
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
billing?, usage?, usageFormat?, lane?, route?, payer?, durationMs?, state?, limits? })`
returns and stores one `CallRecord`. `billing` defaults to `subscription`; passing
`api` explicitly attributes an API key (billed per use) call. Every record carries
`billingLabel: "Person's own plan" | "Person's API bill"`, even without a price
estimate. `payer` defaults to the member.
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

Record host lanes and routes with optional app-supplied `lane` and `route` fields.
`runs(member, from, to)` returns a `RunQuery` per run in first-call order;
`queryRun(member, runId, from, to)` returns one run. Each result contains `runId`,
time-sorted `calls` (including lane, route, model and limits), aggregate `tokens`,
`costs` and `unpricedCalls`, using the same `[from, to)` bounds as `query`.
An absent run returns no calls and zero tokens. A run's totals cover only calls
inside the requested range; pass the run's full time range for its complete total.
Retries and multiple routes/models are added under the app's run id. Members remain
separate even when run ids match. Missing counts stay unknown in run totals, and
the shared member ledger continues to withhold remaining allowance when needed.

`preflight(call, { prices?, allowance?, room? })` reports before a call; it never
sends one, and the caller decides whether to proceed. `call` is `{ provider, model,
billing?, inputTokens, maxOutputTokens? }`: the app counts the request's input and
passes its output ceiling (such as Messages `max_tokens`). It returns `billing`,
`billingLabel`, `tokens: { input, maxOutput?, max? }`, `cost`, `allowance`, `plan?`
and `exceeds`. `cost` is a ceiling from the app's price row (`basis: 'app-prices'`,
`ceiling: true`): every input token at the dearest input or cache rate and output at
its full ceiling, so the real call usually costs less. It is
`{ amount: 'unknown', reason }` for `no-price`, `billing-mismatch` (a plan-backed
call is never priced with an API row, or the reverse), `output-unbounded` or
`invalid-price`; there is no default rate. The estimate is wrong when the app's
input count or price row is wrong, and it cannot know cache hits or actual output.
`allowance` comes from `tokenLedger().query(...).week`: `{ remaining, cap, from, to }`,
`{ remaining: 'uncapped' }`, or unknown when not supplied or a recorded call lacks
counts. `plan` is `roomOf`'s room for subscription calls only. `exceeds` compares
the token ceiling with the remaining allowance and is `'unknown'` when either is;
treat unknown as needing the person's decision, not as room.

Pass a result with a `usage` field directly, or pass just its usage. For accounts'
Messages result and decide's reported answer usage, the default provider format
handles native `input_tokens`/`output_tokens` counts. For OpenClaw `RunEnd`, pass
`usageFormat: 'openclaw'`: its `input` excludes `cacheRead`/`cacheWrite`, so the kit
adds those buckets once and preserves reported output and total. Reasoning is
already part of output and never added again. Missing/inconsistent usage stays
partial/unknown; engine cost estimates, raw answers and secrets are discarded.
`normalizeTokens(provider, result, 'openclaw')` exposes the same pure conversion.

```ts
import { callLedger, memoryTokenLedgerStore, tokenLedger } from '@byokit/usage';
import type { RunEnd } from '@byokit/openclaw';
import type { AnthropicResult } from '@byokit/accounts';
import type { Answer } from '@byokit/decide';

const store = memoryTokenLedgerStore();
const calls = callLedger({ store });
// The app supplies its member policy, run identity and selected lane/route/model.
const limits = tokenLedger({ store, cap: (member) => member === 'member-one' ? 50_000 : undefined });
const context = {
  provider: 'anthropic', account: 'non-secret-account-id', model: 'selected-model',
  lane: 'host', route: 'anthropic-cli', runId: 'run-one',
};
declare const end: RunEnd; // Returned by the kit's existing run; no extra request.
if (end.ok) {
  calls.record('member-one', { ...context, time: Date.now(), usage: end, usageFormat: 'openclaw' });
}

declare const answer: Answer;
// Record once per actual backend invocation, not once per question or cache hit.
// The host selected this API-billed backend only after the person's opt-in.
if (answer.source === 'api') {
  calls.record('member-one', { ...context, route: 'decision', billing: 'api',
    time: Date.now(), usage: answer });
}
declare const messages: AnthropicResult;
// API key (billed per use); consent and the original request belong to the app.
calls.record('member-one', { ...context, route: 'anthropic', billing: 'api',
  time: Date.now(), usage: messages });

declare const runStartedAt: number;
const run = calls.queryRun('member-one', 'run-one', runStartedAt, Date.now() + 1);
const history = calls.runs('member-one', runStartedAt, Date.now() + 1);
const allowance = limits.query('member-one', runStartedAt, Date.now() + 1);
```

The host records either an OpenClaw aggregate result or its individual calls, never
both. Decide can attach one invocation's usage to several answers; record it once,
and skip `source: 'cache'` answers. String-only accounts/answerer results carry no
counts and remain unknown; the ledger makes no recovery requests. Model, provider,
lane and route describe the actual execution and are supplied by the app; there is
no fallback to an API-billed route. Per-run counts stay on device, in memory by
default. A custom store must keep them on device and apply the app's retention
policy. The kit never logs counts, sends telemetry or stores the raw result.
Iteration budgets, stopping rules, consent and presentation belong to the app.

When passing normalized windows to `@byokit/accounts`' structural helper, use
`roomOf(reading.windows, reading.at, 'milliseconds')`. Its two-argument form is for
legacy reset seconds; normalized usage windows in 0.2.0+ already use milliseconds.
Alternatively, this package's `roomOf(reading, nowMs)` returns a structural `Room`
that the accounts chooser accepts directly. Preserve the original measurement time.

`identity(codexSource)` shares the app-server transport, calls `account/read` with a 15-second deadline, never opens a credential file, and returns only `{signedIn,email?,plan?}`. Managed-folder HTTP usage carries only the app-passed headers plus Bearer authorization and JSON accept; it uses the same bounded HTTP transport.

Managed-folder Claude usage uses the shared poll-health and normalized quota pipeline, including scoped hard blocks, unknown usage, last-good observation times, account retry policies and cancellable host origin pacing.

The token and call ledgers accept host-supplied entries/results. For explicit local
JSONL files, the Node entry now provides `harnessLog`; subscription snapshot reads
remain separate from measured token accounting.

```ts
import { harnessLog, callLedger } from '@byokit/usage';
const log = harnessLog({ files: [{ path: '/app/selected/transcript.jsonl', format: 'claude' }] });
const calls = callLedger();
const page = await log.read({ maxBytes: 65_536, maxLines: 256, maxEntries: 128,
  deadlineMs: 100, signal: new AbortController().signal });
// The app supplies real attribution; a log event id is not an account or run id.
declare const member: string, account: string, runId: string, lane: string, route: string;
for (const entry of page.entries) {
  if (entry.provider === undefined || entry.model === undefined) continue;
  calls.record(member, { provider: entry.provider, model: entry.model, account, runId,
    lane, route, billing: 'subscription', time: entry.time, usage: entry.usage });
}
// Continue bounded pages when page.more is true; schedule future polls in the host.
```

`harnessLog({ files, maxLineBytes?, maxIdentities? })` selects exact absolute regular
files, at most 256, without directory traversal, environment reads, credential
discovery, CLIs, network, default paths or background work. Final symlinks are refused.
Platforms lacking `O_NOFOLLOW` return `unavailable` without opening files.
The caller owns selecting trusted paths, including their ancestors. It exports typed
`HarnessLogEntry`, options, page and work counters. It is Node-only; React Native
continues to accept host-supplied entries through the portable ledgers.

Supported dialects are the consumer's synthetic fixtures, not live-log qualification:

- `pi` and `omp`: assistant `message.usage` with input/output/cacheRead/cacheWrite,
  entry id and timestamp. Message timestamp takes precedence for observation time;
  entry id plus entry timestamp deduplicates forks. `message.provider` and model
  are preserved when present; no provider is guessed.
- `claude`: assistant `message.usage` with native token buckets, ISO timestamp,
  message id and requestId. The message/request pair deduplicates per-block and
  resumed copies; synthetic model rows are skipped. Provider is `anthropic`.
- `codex`: `session_meta.model_provider`, `turn_context.model`, then
  `event_msg`/`token_count` with `info.total_token_usage.total_tokens` and
  `last_token_usage`. Valid growing cumulative totals emit the reported last usage;
  repeated totals are skipped. Timestamp plus cumulative total deduplicates copied
  events. Missing provider/model stays absent; malformed observations do not move
  the cumulative watermark. No gaps between totals are estimated or recovered.

Usage reuses `normalizeTokens`: input includes cache subsets, absent counts remain
partial/unknown, and costs, prompts, tool content and raw identities are discarded.
Event `id` is a SHA-256 digest of format and the evidenced event identity. It is
used only for deduplication, never to manufacture a member, account, run, route or
billing attribution. Arbitrary transcript metadata cannot establish those identities.
OpenCode SQLite, other harness dialects and ccusage's daily/session extras are
unsupported. This API does not run ccusage or replace its aggregate results.

Each `read()` returns only newly observed events in explicit file order, with
`work` counters for physical bytes/read calls, checked files, processed lines,
parser calls, malformed/oversized lines, duplicates and resets. Unchanged input
requires metadata checks but reads zero content bytes and invokes no parser.
Byte budgets include lines without usage; no whole-log read occurs per poll.
The default budgets are 64 KiB, 256 lines and 128 emitted entries; upper limits
are 1 MiB, 10,000 lines and 10,000 entries. A chunk is at most 16 KiB. Read-ahead
bytes wait in a bounded buffer and are parsed on later pages without rereading.
Incomplete lines retain bytes across polls and emit only after the newline.
Lines beyond `maxLineBytes` (64 KiB by default, at most 1 MiB) are skipped through
their newline and counted as oversized. Malformed JSON and unsupported usage
identities are counted and omitted; unrelated records are omitted.

Cancellation and the elapsed deadline (100 ms by default, at most 10 seconds)
are checked before/after filesystem operations and between lines. These are
cooperative bounds: an OS filesystem operation itself cannot be interrupted.
`cancelled`/`deadline` pages can contain committed entries: consume them before
resuming. `more` indicates unfinished work, including stopped/error pages; false
can leave an unfinished line awaiting append. Concurrent calls return `busy`
without sharing already-emitted entries. File errors return `unavailable`, without
paths, bodies or OS errors. Invalid configuration throws `HarnessLogError` with
`code: 'bad-source'` and a fixed message.

Inode identity changes, decreases in observed file size and changed metadata at
the same size reset that file's cursor/context. Event digests remain retained so
rotation/replay copies are not counted again. This is an append-only event stream:
old emitted entries are not retracted when a file is replaced or removed. In-place
rewrites that grow a file are unsupported; the writer must truncate or rotate it.
Drain pages before removing/rotating unread files, or explicitly select the retained
archive in a new reader with the host's replay/deduplication policy. This reader
cannot recover bytes removed before it observes them.
Codex cumulative resets within one file are unsupported. Cross-file identities
use exactly the evidenced dialect keys; distinct events with the same key cannot
be distinguished. Reader state is in memory; creating a new reader replays input.
The host owns restart checkpoints, retention and recording each returned event once.

The reader retains at most `maxIdentities` digests (100,000 by default, at most
1,000,000). It returns `capacity` before consuming a new event beyond that limit;
it never silently evicts identities and then emits duplicates. Further progress
requires a caller-owned retention/replay policy and a new reader. No giant-source
or real 10 GB performance result is claimed; qualification measures small synthetic
fixtures through the built public export.

## React Native

The `react-native` condition of `@byokit/usage` selects a portable entry. The explicit
`@byokit/usage/react-native` subpath selects the same API when a bundler does not
use export conditions. It needs no native module, Node shim, credentials or network.
The default Node entry and browser resolution are unchanged.

```ts
import { callLedger, tokenLedger, memoryTokenLedgerStore } from '@byokit/usage/react-native';
const store = memoryTokenLedgerStore(); // Replace with an app-owned synchronous durable store.
const calls = callLedger({ store });
const tokens = tokenLedger({ store, cap: 10_000 });
const time = Date.now();
calls.record('member-1', {
  provider: 'openai', account: 'app-account', model: 'app-model', runId: 'run-1',
  time, billing: 'api', lane: 'host-lane', route: 'host-route',
  usage: { input_tokens: 12, output_tokens: 8 },
});
const daily = tokens.query('member-1', time, time + 1);
const history = calls.query('member-1', time, time + 1);
const runs = calls.runs('member-1', time, time + 1);
const run = calls.queryRun('member-1', 'run-1', time, time + 1);
```

This entry exports `callLedger`, `tokenLedger`, `memoryTokenLedgerStore`,
`TokenLedgerError`, `normalizeTokens`, `priceCall`, `preflight`, all quota parsers listed above,
`codexHardLimit`, `roomOf` and the words helpers, with their corresponding types
(including `RunQuery`, `Preflight`, `PreflightCall`, `PreflightUnknown`). `callLedger` supports the same `runs`/`queryRun` methods and
host-supplied lane/route attribution as the Node entry.
The app supplies provider usage and quota payloads; `usage()`, credential/file
adapters, `identity()`, fingerprints and disk quota stores remain Node-only.

Counts retain reported/partial/unknown provenance. Missing counts remain unknown;
unknown calls suppress a positive remaining allowance. Subscription and API key
(billed per use) calls retain their separate billing attribution. Cost is absent
unless a matching app-owned price table supplies an estimate, labelled
“Person's own plan” or “Person's API bill”; no provider prices are invented and a
subscription quota is never converted into an API charge.

The offline consumer fixture in `test/rn-fixture.ts` exercises the built package's
React Native export. After building, run
`BYOKIT_HERMES=/absolute/path/to/hermes sh scripts/test.sh 'packages/usage/test/react-native.test.ts'`
from the repository root to execute it in a Hermes CLI VM. Without that optional
binary, the same contract runs in a sandbox without Node globals; the Hermes check
is skipped. The standalone fixture uses the locked Expo Babel preset's `hermes-v0`
profile to lower classes for legacy Hermes CLI VMs. This is VM qualification, not
an Expo SDK runtime, emulator or native UI test.

### A consistent plan screen (web and React Native)

Import `planView` from `@byokit/usage/view`, the portable entry with no Node,
credential or network imports. Pass a single snapshot of your call ledger and the
quota reading paired with its account identity:

```ts
import { planView } from '@byokit/usage/view';
import type { CallRecord, Reading } from '@byokit/usage';
const accountId = 'umer-chatgpt';
const calls: CallRecord[] = []; // This account's recorded calls, if any.
const reading: Reading = { provider: 'codex', windows: [] }; // Room left is unknown.
const view = planView({ provider: 'codex', account: accountId, calls, nowMs: Date.now(),
  quota: { account: accountId, reading } });
```

Render `view.label`, `view.roomText`, `view.quotaText`, `view.today`,
`view.activity`, `view.people` and `view.models` together. Today, the 30-day
activity insight, people and models use exactly the same provider/account-filtered
calls. People carry member identities: resolve those to your app's display names.
Do not render identities directly. Counts with missing measurements have no
`tokens`; `knownTokens` is only a subtotal and `unknownCalls` explains the gap.
Empty activity says “No recorded calls”, never that the whole plan was unused.
Quota covers the whole plan, including activity outside the app; it cannot be
inferred from recorded tokens. Failed polls do not imply exhaustion. `room`
retains the observation age, scope and reset timestamp for a meter or reset label.
Use `modelLabel(id)` for model names; unknown ids display “AI model”.

Run `node examples/pwa/serve.ts` and open `/usage.html` for the shared Umer
fixture ledger. In Expo, set `EXPO_PUBLIC_USAGE_DEMO=1`. These examples are
explicitly labelled sample activity and never read a real sign-in.
