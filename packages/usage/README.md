# @byokit/usage

Read subscription usage windows per provider and per account on Node 22.18 or later. Crewhouse can show each member's room, v1 design can meter a payer's plan, and fleet apps can compare account readings. The app chooses an account and supplies labels; this kit makes no choice and estimates no cost.

```ts
import { usage } from '@byokit/usage';
const reader = usage({ stateDir: '/app/state/usage' });
const source = { provider: 'codex' as const, bin: '/app/bin/codex', home: '/app/sign-ins/alice' };
const reading = await reader.read(source);
for (const window of reading.windows) console.log(window.kind, 100 - window.usedPercent);
```

The Node-only `.` entry exports `usage`, `UsageError`, types, `claudeWindows`, `codexWindows`, `goWindows`, `zaiWindows`, `words`, and `usageWords`. There is no portable entry and no dependency on accounts. `./testing` exports `fakeFetch`, `fakeCodex`, and `usageContract(make, { test? })` (or a test function directly).

Sources are `{ provider: 'codex', bin, home, env? }`, `{ provider: 'opencode', key }`, or `{ provider: 'zai', key }`. Paths must be absolute; removed or empty keys mean disconnected. Claude plan-token adapters stay in the host: the host's own Source reads its payload and calls `claudeWindows(raw)`. This package opens no Claude files, sends no Claude headers, and refreshes no sign-in.

`read(source, { nowMs? })` resolves `{ provider, windows, at, code? }`. Remaining room is `100 - usedPercent`; reset times are provider epoch seconds, even outside a plausible clock-display range. `lastKnown(source, { nowMs? })` returns the stored reading only within 24 hours while connected. `connected(source)` and `account(source)` are synchronous; the latter is a salted fingerprint for a host's collection memo. Only bad sources reject with `UsageError` (`code: 'bad-source'`). Failures retain a last-good reading and its original timestamp, with a code explaining the failed update. A good read has no code. Reads have a 60-second floor, per-account concurrent deduplication and a 429 backoff of at least five minutes. `UsageOptions.now` supplies the default clock; a per-call clock overrides it. An injected `fetch` wins; otherwise global fetch is resolved on each read.

Parsers consume Claude's usage/statusline payload, the Go `usage` member, the Z.ai `data.limits` member, or the Codex app-server result (`CodexRateLimitResult`). They carry provider names, normalized kind, percent used, optional duration, reset time, separate limit name and limited flag. Codex windows preserve critical-limit ordering and the eight-window cap. Raw endpoint dialects stay behind this typed surface.

Isolation: the kit reads only the sign-in folder the app passes and spawns only the Codex binary the app passes by absolute path. It discovers no paths and reads no environment variables. The spawn uses an argv array and an environment built from nothing plus the host's `env` and `CODEX_HOME=home`; pass PATH and HOME explicitly when the binary needs them. Tokens never enter logs, errors or readings. Maps hold fingerprints, never raw secrets. The kit reads only `home/auth.json` for Codex identity and writes only `stateDir/plans-v1.json` (0700 directory, 0600 file, atomic rename, 256 KB cap). `salt` defaults to `byokit/usage/account`; a migrating host may preserve its previous salt and stateDir. Legacy stores from before per-account storage are not supported.

The undocumented provider endpoints are fixed to `https://opencode.ai/zen/go/v1/usage` and `https://api.z.ai/api/monitor/usage/quota/limit`, with Bearer keys passed by the host, `accept: application/json`, and redirects rejected. HTTP reads have a 10-second deadline and 64 KB body cap. Codex runs `app-server`, initializes the client and calls `account/rateLimits/read`, with a 20-second deadline, 64 KB stdout cap and SIGTERM followed by SIGKILL after one second. No telemetry or credential write-back.

Tests run the contract with recorded, sanitized payloads and fakes only, behind the repository's egress guard. Real endpoints and real sign-in folders are never run by the suite. `usageContract` takes a bench with `usage`, `source`, `expected`, `nowMs`, `restart`, optional `cleanup`, and optional scripted `fake` (`fail`, `disconnect`, `calls`). Scripted-failure cases skip without the fake seam.
