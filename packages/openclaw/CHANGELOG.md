# Changelog

## Unreleased

## 0.7.0 (2026-10-08)

- FIX: Unreadable sealed sign-ins now fail closed with `AuthStoreUnreadableError` and recovery words, leaving `auth-store.sealed` byte-identical for original-key or backup repair and retry instead of starting signed out with a replacement store.

## 0.6.3 (2026-10-07)

- Dependency update: pins @byokit/relay 0.5.3.
- Dependency update: pins @byokit/link 0.7.1.

- FIX: Route `anthropic-cli` now reports provider `claude-cli`, the id `signedIn`, `providers()` and runs already use for a Claude Code login, so `kit.signedIn(member, route.provider)` answers true once Claude Code is signed in. **Deprecated:** the old provider `anthropic` on this route; it stays readable as `route.deprecatedProvider` (`'anthropic'`) through 0.7.x and is removed in 0.8.0. Match this route by `provider === 'claude-cli'` (or by `choice === 'anthropic-cli'`). The route id `anthropic:cli:anthropic-cli` is kept through 0.7.x and becomes `claude-cli:cli:anthropic-cli` in 0.8.0; choice `anthropic-cli` and the `{ provider: 'claude-cli', via: 'browser' }` link selector are unchanged. `anthropic` remains the API-billed provider only: a Claude Code login never makes `signedIn(member, 'anthropic')` true.
FIX: Engine start on macOS no longer sticks on a dead-but-unreaped guard process. `pidAlive` detects zombies portably — `ps` state where there is no `/proc` — instead of Linux-only `/proc`, so a stale guard reads as stopped and start can recover. A live pid still reads as owned, an invalid guard still reads as ambiguous, and anything unexpected from the probe keeps the guard. Linux answers are unchanged.
- FIX: Code sign-ins whose pinned engine prints the code only into a note now hand the caller the code, link, expiry (`expiresAt`) and instructions (`message`) in the same `SignInView` shape as structured codes, and wait out device approval instead of failing with `gateway request timeout for wizard.next` after two minutes.
- The O16 day-usage engine tests no longer fail when a run straddles UTC midnight: a case that could still be running at midnight starts just after it, so the day (and month) it reads is the day its engine stamps charges in.
- The `relay` option takes anything with `RelayClient`'s `notify`, so a host can hand the kit a relay it opens after `Host.open` (the client needs the open host). A `RelayClient` still fits; behaviour is unchanged.
- FIX: The sealed credential store is written as `v: 1` again. 0.6.2's `v: 2` tag made every earlier kit (through 0.6.1) refuse an intact store with `invalid sealed credential store`, so a host rolled back to an earlier kit could not start and lost its saved sign-in. `v: 2` stores still restore and re-seal as `v: 1`.
- A saved store the key cannot open (a different key, damaged or tampered bytes) or whose payload is not a credential snapshot no longer blocks engine start: it is kept as `auth-store.sealed.unreadable-<ms>` (never overwritten or deleted), the engine starts signed out, and the kit reports `{ phase: 'ready', why: 'sign-in-reset' }` with the words "Your saved sign-in couldn't be opened, so it was kept aside. Sign in again." until a sign-in through the kit completes.
- FIX: Every wizard `text` step now reaches the caller as `SignInView.prompt`, not only sensitive ones. A non-sensitive step shows the engine's question as written (`github-copilot-enterprise` asks for the Enterprise domain first), so the sign-in no longer waits 15 minutes on a screen with nothing to answer. Once a step is sensitive (or the choice is `setup-token`), the prompt stays the fixed `Sign-in token` label and no gateway prose is shown, as before.
- FIX: `setup-token` is no longer offered. The pinned Gateway has no app-guided sign-in for it and refuses every attempt with "That provider setup is not available on this Gateway.", so it is listed with `readiness: 'no_upstream_flow'`, the link no longer maps `{ provider: 'anthropic', via: 'browser' }` to it. `plugins.allow` now holds the plugin of every default-eligible bundled route rather than only the ready ones, so `anthropic-cli` and `apiKey` keep the `anthropic` plugin allowed without app config.
- The R1 restart-recovery probe accepts both restart-time gate denials for the unowned recovering session (HEAD's `unknown run` and the published kit's `can't check this action right now`); any other transcript text still fails the denial assertion.

## 0.6.2 (2026-10-05)

FIX: The browser broker now holds its CDP endpoint back until Chromium's initial tab exists, so `/json/list` can never serve an empty browser to an attaching engine on a cold or slow start; a browser that never lists a tab fails the launch honestly instead.
- Remove the fake Gateway's own happy-path self-tests for default member/auth and the device-code wizard script from `test/fake.test.ts`. They asserted the synthetic fixture's own response shapes and exact number of progress pulls, not product behaviour. Member creation, caching and validation, device-code sign-in through `kit.signIn`/`kit.signedIn`, `health` pass-through and sign-out remain covered by the shared public consumer contract (`src/testing/contract.ts`) and the packed Chromium journey in `examples/openclaw-kit/e2e.test.ts`. Every negative, cancellation, denial, gate, drop and refusal assertion is kept unchanged, and no test was added.
- The quickstart's example output is what the example actually prints today: the offered-route list was stale
  (it still showed `anthropic-cli` and a browser `setup-token` and missed `opencode-go`). The block is now the
  real output of the runnable fake-Gateway example, followed by a "read next" pointer to the run contract, the
  kit example and SECURITY.md.
FIX: The sealed credential store now seals credential state only — the complete `state` tree plus config/credential paths under `home` — instead of the whole engine home, so a real signed-in home with tool caches no longer produces a sealed payload past the runtime string limit and aborts boot. Regenerable caches, transcripts and logs (`home/.cache`, `home/.npm`, and the `sessions`/`log`/`cache`/`.tmp`/`history.jsonl` subtrees of `.codex`, the `projects`/`todos`/`shell-snapshots`/`statsig`/`file-history`/`history.jsonl` subtrees of `.claude`) stay on disk unsealed; unknown `home` paths stay sealed. The sealed payload is built exactly once and verified by decrypting the sealed bytes. Existing `v: 1` snapshots still restore completely and re-seal once as `v: 2` with a log line; no credential is ever dropped.
- Every type an entry hands a caller is now nameable from that entry, and none of them carries `any`.
  `.` exports `GatewayMethods`, `RouteView`, `RouteFacts`, `JsonValue`, `UsageClient` and `DayUsageClient`;
  `./device` exports `OpenClawDevice` and `DeviceEndFrame`; `./link` exports `OpenClawLinkOptions`,
  `OpenClawLinkHost`, `OpenClawServeOptions` and `OpenClawServeHandle`; `./testing` exports `FakeGateway`,
  `FakeHandler`, `FakeParams` and `StubRequest`, types `fakeGateway`'s script per method, and records each
  stubbed request as a typed `StubRequest` instead of `any`. An app can write its own generic wrapper over
  `call` and annotate what `routes()`, `openclawDevice()` and `openclawLink()` return without a cast. The
  Gateway slots the pinned engine does not declare stay `unknown` and are listed per release in
  `src/generated/report.json`; the README now says so beside the API table.

## 0.6.1 (2026-10-04)

FIX: Let apps declare `appOwnedSessions.keyPrefixes` before Gateway startup so caller-requeued task sessions do not also receive an engine-started recovery turn. Preserve session history, policy gates, API-key session mapping and stock recovery for other namespaces.
FEAT: Add the internal pipe-only browser broker with fenced private targets, lease-bound live sessions and exact-origin site-data clearing. Sign-in handoff remains unprotected until parked-session protection is qualified.
FIX: Launch each broker's Chromium with its own short mode-0700 temp directory under the caller's temp directory, removed on close, instead of using the profile path as TMPDIR; deep app profile paths overflowed Chromium's singleton socket path and aborted startup.
FIX: A controlling viewer ignores frames from a previous target and drops input until the current private target has delivered its first image, so popup switches cannot map input with stale coordinates.
FIX: The broker's browser endpoint and `/json/version` now use Chromium's canonical `/devtools/browser/<id>?token=` shape, so the pinned engine's CDP discovery finds `/json/list` instead of failing with HTTP 404; token, host and origin guards are unchanged and the old bare path is refused.
FIX: Chromium's sandbox stays on; a launch refused for no usable sandbox (for example where unprivileged user namespaces are disabled) now fails with typed `BrowserSandboxUnavailable` instead of a generic failure, and is never retried unsandboxed. Startup stderr is used only in memory for that check.
FIX: Wire opt-in member browsers to the shipped bridge and stock engine, with a dead default profile, member-pinned browser actions, kit browser invalidation events and scoped browser-engine checks. Sign-in handoff remains `handoff-unprotected`; no recovery-protection or automatic resume redispatch claim is made.
SECURITY: Register the published awaited OpenClaw/Codex tool-result middleware, scrub owned broker capabilities before live model feedback, recheck session admission per result, and terminate on refusal or unavailable protection. Transcript hooks are supplementary; actual full privacy/recovery qualification remains pending.
FIX: Honor the stock allow/alsoAllow schema, create model-free audit sessions for effective-tool checks, and acknowledge redacted CDP profiles only against an unchanged exact host-owned endpoint and matching applied-source revisions.
FIX: Explicitly clear hostile node selection across the stock hook's shallow parameter merge; browser proof fixtures distinguish normal model completion from successful tool execution.
SECURITY: A definite failed sign-in resume no longer permits arbitrary recovery turns: replacement requires a fresh live kit registration matching the exact engine run id and session, revoked on release or bridge shutdown. Source controls cover parked and every unproved resume state; actual engine qualification remains pending. Reconnect keeps tool subsets but revokes submission authority, and waits for old Unix socket teardown before rebinding; shutdown cancels outstanding calls.
SECURITY: Browser use requires a closed explicit safe tool policy across every engine agent, account agent and delegate; unsafe and unknown effective tools refuse every browser, model-facing profile management/evaluation is blocked before app approval, and raw agent/plugin/config policy mutations require the guarded config path.
- FEAT: Portable types for the browser sign-in handoff and live view (`NeedSignIn`, `BrowserState`, `LiveViewState`, `BrowserHost`, `BrowserDevice` and friends) from `.` and `./device`, per spec 5.17. Types only: no runtime ships yet, and handoff stays refused until parked sessions are protected.
- Allow the internal browser host to attach newly created owned-member browsers and replace exact owned endpoints with stale-identity guards, private-target cleanup barriers and read-only versioned bindings for guarded configuration publication. Request bounded thumbnails through the owned viewer. Production sign-in handoff remains blocked pending qualification.
- Add the internal browser handoff host, durable settlement and conservative resume bookkeeping, with offline synthetic fixtures. Production sign-in remains blocked pending recovery-protection qualification.
- Add member-scoped browser sign-in actions, private browser live view and portable device helpers. Browser frames and lease capabilities travel on transient encrypted streams, outside durable link answer caches; control requires the host's immediate grant-revocation seam. Watching or reconnecting never dispatches a model run.
- FIX: Preserve browser reply and event order when messages arrive together, so page evaluation can receive its initial context instead of waiting indefinitely.
SECURITY: Ship a content-addressed bundled-engine patch manifest and the pinned OpenClaw MIT notice. Fully verified read-only sibling engine sets replace in-place installation; base and existing set bytes are never changed, even when shared Gateways are live. `KitState.patchSet` and `why: 'engine-patch'` expose provenance; rollback selects verified stock offline, while stock drift may need registry access. The initial patch set is empty.
- `getConfigKey` / `setConfigKey` read and write exactly one dotted config key in the file `prepare()` owns, so an app can narrow-read and restore a value (for example `skills.workshop.autonomous.mode`) around a boot without a whole `config.get`, whose result redacts token-bearing values. Only that key changes, the write is atomic in `prepare()`'s exact shape and happens only when the bytes change, and `undefined` removes the key.
FEAT: Add portable `readAgentDayUsage` / `AgentDayUsage` readings that combine fresh retained transcripts with durable Gateway Skill Workshop review charges. UTC/IANA windows, pending/interrupted/missing usage and conservative completeness let callers keep unknown budgets unknown. The original partial usage API is unchanged; other detached kinds and the worker bundle remain uncovered.
FIX: Persist detached Workshop review usage, including reported usage on failed outcomes, without double-counting memory flushes, recovery resumes or run results. Per-boot/month attempt counters, fsynced launch and clean-stop records, phase deduplication and bounded month reads preserve failure holes and crash incompleteness.
SECURITY: The bundled checksum-pinned Gateway Workshop patch and operator-read usage RPC write/read accounting identities, times and reported counters only, never prompts, outputs, tool arguments or credentials. Device reads stay member-scoped and never access host files; unknown costs and unverified billing identity are not guessed.
FIX: `stop()` now signals only the pids the kit itself spawned and never a process group, so shutdown no longer reaches processes the kit never started. Every spawn is recorded when it starts and dropped when it exits; the gateway is left to shut its own sessions down on its own SIGTERM.
- Unreleased source dependency metadata: pin @byokit/seal 0.3.0 and @byokit/relay 0.5.2; this package's existing version is not republished. Previously published consumer metadata remains unchanged.
- SECURITY: Sensitive subscription sign-in tokens stay out of sign-in views and results, including engine errors, links and codes after token entry.
- FIX: Subscription setup-token sign-in now answers sensitive wizard text steps from the existing paste channel, once per step, with cancellation and timeout preserved. API key (billed per use) entry still requires explicit selection.

## 0.6.0 (2026-10-02)

- Portable `readAgentUsage` / `agentUsageOf` expose explicit-agent UTC retained-transcript totals with raw responses, cache freshness and missing-price counters preserved. Coverage stays partial: stock-engine detached Workshop reviews are absent, and unavailable data never becomes zero; complete internal-turn accounting is not claimed.
- FIX: Host runs can reuse a caller-stable per-dispatch `idempotencyKey` after a lost connection instead of starting a second engine run. Omission keeps fresh UUIDs. Document the pinned engine's gateway-wide, bounded, in-memory cache and honest in-flight replay limits; this is not exactly-once across engine restarts.

FIX: Generate complete pinned route discovery: 91 auth choices and five cloud/CLI providers, including external plugin dependencies, plan-key entry, service grouping and corrected provider/billing labels. `routes()` computes readiness without reading credentials or installing plugins; legacy boolean `offer` is ready default subscriptions only, with `offerPolicy` retaining eligibility. Missing plugins, binaries, client registrations and choiceless wizard flows remain visible, not falsely usable. Explicit API/local/endpoint routes never become default billing; endpoint billing requires host input. Full discovery also reaches the existing phone/web link without hiding unavailable rows. Existing choice IDs, legacy explicit browser/code selectors, native Claude activation guards and ChatGPT pairing are retained; corrected manifest provider IDs and semantic `via` values replace inaccurate discovery labels. Listing an API or unavailable route never authorizes a sign-in or makes it a default.

- The README points to the shared account-route vocabulary (D18); pinned route discovery is not proof of additional implemented authentication flows.
- FIX: ChatGPT sign-in now interrupts abandoned wizard/paste waits on gateway disconnect and reconfirms a new, usable OAuth profile for the selected member through the reconnected engine. Recovery is bounded and fails closed for unknown, missing, pre-existing or unrelated credentials, cancellation and expiry. A synchronous cleanup error during reconnect no longer suppresses the terminal sign-in view.

## 0.5.0 (2026-10-01)

- Dependency update: pins @byokit/relay 0.5.1.

- FIX: Wait for approval callbacks in the bridge parking test instead of assuming the gate finishes within 50 ms.
- FIX: Successful runs preserve complete generated text in the final callback and result instead of replacing it with a capped terminal snapshot; silent and empty replies remain empty.

- Add app-supplied output schemas to host and device runs, with inferred result data, local final-answer validation and typed output failures. Subscription routes and explicit API key (billed per use) opt-in are unchanged.

## 0.4.0 (2026-10-01)

- Dependency update: pins @byokit/ui-core 0.6.0.
- Dependency update: pins @byokit/reach 0.6.0.

- Key readiness waits through the engine's retryable restart refusal after activation; missing keys still fail without another account.
- API key (billed per use): `addKey` verifies and stores an explicitly entered key in a separate member-owned agent, with copying disabled and no automatic subscription fallback. `run({ auth: 'apiKey' })` selects it explicitly with separate history; key-entry labels, errors and route revision dates are included.
- Offer subscription sign-ins, including pasted tokens and native Claude Code, by default and allow their provider plugins. API key (billed per use) routes remain app opt-in; proxies, compatibility aliases and local routes stay off.

## 0.3.6 (2026-10-01)

- FIX: Live orphan gateways recover after the engine rewrites its process title. Recovery verifies the recorded launch pid and process start time with the executable and isolated store paths; ambiguous ownership preserves the saved sign-in state.

- Dependency update: pins @byokit/ui-core 0.5.0.
- Dependency update: pins @byokit/reach 0.5.0.
- Dependency update: pins @byokit/relay 0.5.0.
- Dependency update: pins @byokit/link 0.7.0.
- SECURITY: (from @byokit/link 0.7.0) `Host.shortCode()` adds a machine-key commitment to typed pairing; `pairWithCode()` verifies it before disclosing device identity or asking for approval. Legacy codes remain compatible; use the full new code when relay lookup is untrusted.

## 0.3.5 (2026-10-01)



- FIX: Failed engine starts no longer remove another live gateway’s guards or saved sign-in state. Verified dead-host gateways stop gracefully before restart; ambiguous ownership returns a typed engine-already-running error and preserves the store.

## 0.3.4 (2026-09-30)



- FIX: Device-code sign-in waits for the engine’s code expiry instead of failing after two minutes; caller cancellation and expiry return typed outcomes with plain words.
- Offer the native Claude Code / Agent SDK subscription route (`claude-cli`, plugin `anthropic`), keeping login in Claude Code in the isolated engine HOME. Sign-in uses engine detection and live activation; `oc.state` reports native login readiness.
- Support explicit Anthropic API key activation with a per-use billing label and secret-safe views; never offer an API-key fallback. Direct Claude.ai OAuth and setup-token offers remain excluded.
- Verify native and API per-run provider/model forwarding, tool events and strict refusal of `@profile` pins.

## 0.3.3 (2026-09-30)

- Dependency update: pins @byokit/secrets 0.5.0.

- SECURITY: Opt-in dual-wrap credential upgrades are authenticated and atomically replaced under the store lock; protection is only as strong as the owner-only host-key file, which must stay out of sealed-store backups.
- FIX: A locked or unresponsive keyring no longer throws from prepare or start. The kit reports a locked saved sign-in in plain words, preserves the sealed store and retries normally on a later start after unlock; dual-wrapped stores open through their host key without prompting.

- FIX: ChatGPT subscription device pairing was blocked by the plugin allowlist unless the app added the provider plugin itself. The kit now merges every offered route's provider plugin with the bridge and caller-provided plugins, without adding plugins for unoffered routes.
- Label the explicit Anthropic route as API key (billed per use), keeping API and plan routes off by default.

## 0.3.2 (2026-09-30)

- Dependency update: pins @byokit/secrets 0.4.0.

- SECURITY: View-only devices can no longer resolve approvals through relay push actions.
- FIX: Existing authSeal calls using osKeyringSeal automatically pick up persistent headless sealing, including locked and unresponsive keyring fallback, without host changes.
- Document the credential, migration and sealed-approval threat model in SECURITY.md, shipped with the package.
- Run the shared engine isolation contract in npm test with an offline child; keep the pinned-engine check in test:engine.

## 0.3.1 (2026-09-30)



- FIX: `authSeal` no longer rejects retained-login migration when engine state contains symlinks or runtime entries. File symlinks whose fully resolved targets are regular files inside the isolated engine root are sealed and restored as regular files at the link paths; outside-root, dangling and directory symlinks (including loops), sockets, FIFOs and devices are skipped without reading their contents.
- Depends on @byokit/ui-core 0.4.0.

## 0.3.0 (2026-09-30)



- SECURITY: Provider access and refresh tokens persisted in plaintext engine stores; hosts can now pass `authSeal` from `@byokit/secrets` to seal the isolated stores while stopped and protect migration archives. Upgrade and call `prepare()` with an OS-keyring or host-owned-key adapter; protect live state and backups separately.
- SECURITY: Verified retained-login sources are removed instead of archived in plaintext; existing confirmed copies and engine migration archives are removed or sealed on the next prepare.

## 0.2.5 (2026-09-30)

- Dependency update: pins @byokit/relay 0.4.2.
- Dependency update: pins @byokit/link 0.6.0.

## 0.2.4 (2026-09-30)

- Dependency update: pins @byokit/relay 0.4.1.
- Dependency update: pins @byokit/link 0.5.1.
- FIX: (from @byokit/link 0.5.1) Reject an authenticated empty transport frame instead of decoding it as an empty control message.


## 0.2.3 (2026-09-30)



- FIX: `prepare()` repairs stale engine manifests and missing or wrong-version dependencies before reusing an installed engine.


## 0.2.2 (2026-09-30)

- Depends on @byokit/relay 0.4.0.

## 0.2.1 (2026-09-30)

- Depends on @byokit/relay 0.3.1.
- Depends on @byokit/reach 0.4.0.
- Depends on @byokit/link 0.5.0.
- FIX: (from @byokit/link 0.5.0) `decodeOffer()` reads legacy compact direct pairing codes with checksum, padding, bounds and expiry validation; new encodings keep the complete current format.

- Dependency update: pins @byokit/link 0.5.0, @byokit/reach 0.4.0 and @byokit/relay 0.3.1.

## 0.2.0 (2026-09-30)

- Full run options over the link (v1 A6): `oc.run` and `openclawDevice(link).run(message, o)` forward `system`,
  `images`, `thinking` and `tools`, each type-checked. `RunSpec.tools` is the run's subset of the app's tools
  (`KitOptions.tools` names, listed by the new `kit.toolNames()`): the bridge refuses any other app tool before
  `ToolHost.gate` sees it, engine builtins are unaffected, and a name the kit does not register is refused before the
  engine is called (over the link, `link.notAllowed`). The pinned engine takes no per-run tool list, so the model
  still sees every tool; the gate is the enforcement. Runs sharing a session key share the narrowest subset.
- Structured tool events (v1 A7): a `tool` `RunEvent` carries the engine's `id` (its toolCallId) on both ends, the
  call's `input` on `start`, and the engine's `output` and `error` on `end`.
- Usage (v1 A8): `RunEnd.ok` carries `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `total`,
  `costUsd`), the engine's own total for the run from the `agent` request's final frame, and `planWindow`
  (`{ provider, plan?, windows: { label, usedPercent, resetAt? }[] }`), the engine's cached read of the
  subscription's quota for the run's provider. Each is present only when the engine reports it; nothing is estimated.
  New types `RunUsage` and `PlanWindow` (`.`, `./device`).
- Presence and version (v1 A12, device side): `oc.state` (`openclawDevice(link).state()`, typed `DeviceState`) adds
  `version` (this kit), `engine` (`ENGINE_VERSION`) and `signedIn`, the providers the device's member is usably
  signed in to (not an expired or unfinished sign-in), absent while the engine can't say.
- FIX: a run ending no longer drops another live run's registration on the same session key (its tool calls then
  failed as an unknown run); a key stays registered until its last run ends. `Bridge.register` returns the release.
- FIX: the engine's `update`, `input_delta` and `review` tool phases no longer end a tool pair early; only `result`
  (or `end`) does.
- Testing: the fake Gateway's runs are engine-shaped (`toolCallId`, `args`, `result`, `isError`; an `accepted` frame
  and, with `expectFinal`, a final frame with `agentMeta.usage`), and the model stub ends a reply asked
  `stream_options.include_usage` with a `STUB_USAGE` chunk (exported from `./testing`). `GatewayTransport.request`
  options take `expectFinal` and `onAccepted`.

## 0.1.4 (2026-09-30)

- Depends on @byokit/relay 0.3.0.

## 0.1.3 (2026-09-30)

- Depends on @byokit/relay 0.2.2.
- Depends on @byokit/link 0.4.0.

- Depends on @byokit/ui-core 0.3.0.

## 0.1.2 (2026-09-30)

- Preserve seed-based notice opening with @byokit/seal 0.2.0.

## 0.1.1

- Depends on @byokit/reach 0.3.0.

## 0.1.0 (2026-09-29)

- First release on npm (docs/runtime-kits.md §10). `examples/openclaw-kit` (O12) is the whole flow from a phone
  browser: pair, sign in with ChatGPT by device code, a streamed run, a tool that asks first, Allow and Deny. Its
  e2e runs in CI from the packed packages against the fake Gateway; `LIVE.md` is the real-engine check.
- `.` and `./device` export the kit's sentences (`words`, `stateWords`, `toAccountView`, `WordKey`, `AccountView`),
  and `./device` the types a device screen needs (`Approval`, `Decision`, `KitState`, `Route`, `RunEnd`, `RunEvent`,
  `SignInView`).
- FIX: `oc.signin.view`'s `ready` (and so `openclawDevice(link).signIn.view(p).ready`) is the member's sign-in to that
  provider, not the engine being up. Before, a phone's `phaseOf` said `done` while the device code was still showing,
  and a member who was never signed in looked signed in.
- FIX: `signIn.view(p)` drops a finished sign-in once its account is gone (signed out over the link, on the computer,
  or by the engine), so it no longer shows that old sign-in as done.
- Depends on @byokit/link 0.3.2.
- Depends on @byokit/relay 0.2.1.

- FIX: the account an app picks for a run is now the one the engine calls and bills. `RunSpec.model`
  (`'provider/model'`, also `oc.run`'s `model` and `openclawDevice(link).run(message, { model })`) goes to the engine as
  that run's own provider and model, with no fallback to another provider or model. A provider the member isn't
  signed in to ends the run `signed-out` before the engine is called. A malformed reference, or one carrying an
  `@profile` sign-in pin, is refused. Leaving it out sends the same request as before. The choice is per provider:
  with two sign-ins for one provider the engine may still switch between them, so a single sign-in can't be picked.

- Typed device pass-through (G4, docs/runtime-kits.md 7.2): `openclawDevice(link).call<M>(method, params)` returns
  `GatewayResult<M>` from the generated table (params now required, as on the kit), `events()` yields
  `OpenClawLinkEvent` frames, and `./device` re-exports the table types. The device gains `sessions()` (`oc.sessions`,
  *view*) and `signOut(p)` (`oc.signout`).
- FIX: `GatewayParams` for every anyOf/oneOf method now carries each branch's full property set from the pin's `protocol.schema.json` (re-emitted into `src/generated/params.ts` by `npm run gen:openclaw`), so `kit.call('cron.run', { id, mode: 'force' })` compiles; branch requirements the old types dropped (`cron.scratch.set` content, `cron.update` patch) and oneOf exclusions (`sessions.dispatch`, `exec.approvals.node.set`, `audit.run.inspect`, spelled as `prop?: never`) are enforced the way the gateway validates them.
- SECURITY: the operator install policy blocks any skill request whose kind contains `depend` (e.g. `skill-dependency-install`) even under an own root; previously only `installSpec` installer fields were checked.
- FIX: the trusted-skill version check uses `request.origin.version` when present and falls back to the `SKILL.md` frontmatter version, so reviewed bundled skills without a frontmatter version match their trusted entry.
- SECURITY: the bridge aborts the `AbortSignal` handed to `host.call` when that call's plugin socket closes or errors before the reply is written, so an aborted run no longer leaves the sandboxed command running; the listener is removed after a normal reply.
- SECURITY: the bridge plugin's `before_tool_call` relays every tool call to `ToolHost.gate`, engine builtins (`web_fetch`, `web_search`, memory and skill tools) included; before, anything outside `tools` ran ungated. The gate gets a fourth argument `{ builtin }`, an allowed builtin gets no permit or ticket, an unregistered session key is denied unless `allowOnce` matches, and a kit with no host blocks every tool. `KitOptions.gateBuiltins: false` restores gating only the app's tools. `prepare` now rewrites a stale `plugin/index.js`, so existing state dirs pick the gate up. A tool name the engine would rename before the hook (not `/^[a-z][a-z0-9_]*$/`, or `bash`/`cron`) is refused at construction, so an app tool never reaches the gate marked builtin.
- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.
- FIX: `gatewayTransport` reads the Crewhouse legacy `device.json` shape (`deviceId`, `publicKeyPem`, `privateKeyPem`) as well as the kit's (`privateKey`, `publicKey`); an existing file is only read, never rewritten, and a file holding neither shape fails naming the file.
- FIX: `OpenClawKit.call()` before `start()` returns a rejected promise (`gateway not ready`) instead of throwing synchronously.
- The bridge no longer keys behavior on the plugin id: `KitOptions.bridge` (`socketName`, `paramPrefix`,
  validated, defaulting to `bridge.sock` / `__byokit`) replaces the `crewhouse` special-cases, and
  `startModelStub` takes a configurable `idPattern` and routing marker instead of a fixed prompt grammar
  (docs/runtime-kits.md §§5.5/5.9; adopting apps pass their own values explicitly).

- `./testing`: the fake Gateway (`fakeGateway`), the contract suite (`openclawContract`, also run against the real
  pinned engine) and the scripted model (`startModelStub`/`useModelStub`), ported from Crewhouse's test stubs with the
  script grammar unchanged (docs/runtime-kits.md §5.11).
