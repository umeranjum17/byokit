# Changelog

## Unreleased

## 0.6.5 (2026-10-10)

- Dependency update: pins @byokit/accounts 0.21.0.
- FIX: (from @byokit/accounts 0.21.0) ChatGPT `respond` answered from the saved default (or the first account) whatever account the caller had picked, so a two-account pick could stream from the wrong sign-in and a failure rested the wrong account; a selected account's refusal now rests only that account, and an explicit signed-out id is refused with `ResponseError` kind `signed_out` before any request.
- FIX: (from @byokit/accounts 0.21.0) A second Google browser sign-in on a callback port this process already holds (another member's sign-in, or another app process) no longer publishes a URL whose redirect the holder's listener answers out of date and then waits for the `redirectMs` timer; it waits for the same port the holder uses and offers its pasted-address view at once, while the wait still serves the browser return if the port frees.
- SECURITY: (from @byokit/accounts 0.21.0) The Google refresh token is sent only to Google's own revoke host (or its `googleBase` stand-in), never to `authBase`, and it never appears in a thrown message or a log; a failed revoke still deletes the local sign-in.
- FIX: (from @byokit/accounts 0.21.0) `classifyFailure`/`classify` now read the ChatGPT/Codex "Next reset in N min/minutes/hour/hours" wording as well as "try again in ~N min/h", so a subscription refusal rests the account until the stated reset instead of the 60-minute fallback; a rate limit that names no reset still falls back.

## 0.6.4 (2026-10-09)

- Dependency update: pins @byokit/link 0.8.0.
- Dependency update: pins @byokit/accounts 0.20.0.
- SECURITY: (from @byokit/pair 0.9.0) pinning and approval semantics. A compact QR's pending grant pins the key the code handshake authenticated, kept after Noise message 2 and before the device's identity goes out in message 3; if saving it fails, pairing stops before the computer learns the device. A device using `onPending` says so inside the handshake, and only then does the computer keep a yes given after its socket dropped, granting only the device key that handshake authenticated; any other device that leaves still gets no grant. A computer with another key at the same address is still refused, and a version 1 `pendingGrant` refuses a `host` that differs from its QR.
- FIX: (from @byokit/pair 0.9.0) a phone killed while the person at the computer decides now resumes against the pinned computer, for compact and version 1 QRs alike. `pairWithOffer` takes `onPending(grant)`, which hands over the pending grant to keep before the computer can approve this device, and `pendingGrant` accepts a compact QR given the authenticated `host` key, and `parseOffer` reads a compact QR for inspection (expiry, addresses, name, role) without one. Before, `pendingGrant` refused compact QRs, and even a version 1 pending grant never came online after a real kill. A socket that drops once the computer has taken the code now ends pairing with `unreachable` instead of trying the next address, where the spent code or ticket could only be refused as `wrong-code` or `expired`. A socket that closes while `onPending` is still saving ends pairing at once with that close; a version 1 `onPending` that never settles times out. The compact QR is unchanged: 109 characters for one relay address and the name Umer.
- FIX: (from @byokit/pair 0.9.0) the pairing picture's words match what the host now prints: scan the code, or type the shown code where the phone page asks for it, with no raw address to type.
- FIX: (from @byokit/pair 0.9.0) the browser pairing test closes only the Chromium processes it spawned — over that browser's own private CDP pipe — instead of signalling a whole process group, so a killed or timed-out test can no longer take out or leave behind the wrong process tree. `BYOKIT_CHROME` is the single documented key that selects the test browser.

## 0.6.3 (2026-10-08)

- Dependency update: pins @byokit/accounts 0.19.0.
- FIX: (from @byokit/accounts 0.19.0) Add member-scoped custom OpenAI/Anthropic-compatible endpoints and explicit local presets using the pinned provider/model adapters. Billing is a required choice (or preset fact), never inferred from a hostname; Auto and Default refuse non-subscription accounts.
- SECURITY: (from @byokit/accounts 0.19.0) Endpoint keys stay in the member's selected device key backend; loopback readiness precedes credentials, and endpoint models never enter another member or default runtime.
- SECURITY: (from @byokit/accounts 0.19.0) Key-route accounts keep secrets only in the member's device-owned keyStore, with no plaintext or ambient credential fallback. Selected-key helpers override credential headers and explicitly refuse opaque SDK clients before secrets; unmodified typed native Pi pass-through remains available for explicit client-owned authentication.
- FIX: (from @byokit/accounts 0.19.0) Key routes share account persistence and retain their pinned subscription or API key (billed per use) billing; non-subscription accounts are never an Auto or Default fallback.
- FIX: (from @byokit/accounts 0.19.0) Portable key routes lazily load a reproducible split artifact of unmodified pinned Pi adapters; Google uses global fetch while preserving the upstream custom-fetch refusal.
- FIX: (from @byokit/accounts 0.19.0) Browser and React Native key routes now opt in through `@byokit/accounts/keys` (`withKeys(portable)`), so the main portable entry no longer carries the adapters or vendor SDKs; without it, answering a key route reports `needs_keys` before any secret is read.
- SECURITY: (from @byokit/accounts 0.19.0) repository CI temporarily excepts only npm braces GHSA-vfj7-8cjw-p6xm (affected <=3.0.3), accepting build-tool DoS risk from developer-config glob patterns, no user input, and no patched release; this is risk acceptance, not newly proved input safety or a shipped vulnerability fix. Remove by 2026-11-02 00:00 UTC; the gate fails at that deadline or as soon as authoritative GitHub metadata reports a patched version. Metadata failures fail closed. Valid npm dependency cycles count every reachable advisory; unrelated high/critical advisories and malformed reports still fail.
- SECURITY: (from @byokit/accounts 0.19.0) The device code, the poll and the refresh stay between the app and the provider's own endpoints; the stored credential is the OAuth pair Pi keeps, no token is logged, printed or written anywhere but the member's own store, and a provider without a documented revoke endpoint is simply not revoked.
- FIX: (from @byokit/accounts 0.19.0) The Claude plan inference route no longer sends a frozen `claude-code/2.1.74` User-Agent that Anthropic answers with `signed_out`. The client value is the host's: pass `claudeUserAgent` (or a `headers` entry) and your value wins; with none passed, no client version is sent. A caller's header now overrides the route's defaults instead of the other way round.
- FIX: (from @byokit/accounts 0.19.0) A Claude plan refresh that gets no answer or a server error keeps the sign-in and tries the same grant next time, instead of deleting it; only the provider proving the grant revoked (`invalid_grant`) removes it, and a grant that may be spent stays marked in the store so no process sends it again.
- FIX: (from @byokit/accounts 0.19.0) Concurrent app processes wait for the fixed OAuth callback port before starting browser sign-in, instead of failing busy and asking the person to start again. Waiting respects cancellation and the sign-in deadline; callback state checks are unchanged.
- FIX: (from @byokit/accounts 0.19.0) A device sign-in whose provider keeps its grant on refresh (no new refresh token, as Grok or Kimi may answer) now stays signed in instead of asking to connect again after its first refresh. Claude Pro/Max still requires a rotated grant.
- FIX: (from @byokit/accounts 0.19.0) `fileStore` now serializes every write, a whole refresh included, across processes sharing its path through a `<path>.lock` file beside it, so two app processes refreshing one sign-in at once keep the fresh credential instead of spending a used grant and marking it for sign-in again; a crashed holder's lock is removed. A Claude plan refresh no longer reports expiry from another process's refresh in flight.
- FIX: (from @byokit/accounts 0.19.0) A person signs in once per computer: new `machineStore(member, seal)` (Node entry) keeps each person's sealed sign-ins at one conventional path every app shares (`~/.local/share/byokit/people/<member>/auth.json`, `~/Library/Application Support/byokit/...` on macOS, `AppData\Roaming\byokit\...` on Windows), so a second app holding the same seal, such as `osKeyringSeal({ service: 'byokit' })`, is signed in already. Breaking: `Accounts` no longer falls back to an in-memory store that loses every sign-in at restart; pass `store`, and `memoryStore()` only when sign-ins should end with the app. The decide-plan and realtime-voice examples now keep sign-ins at the machine store.
- FIX: (from @byokit/accounts 0.19.0) Manage named native Pi 0.87.1 subscription accounts with TUI sign-in instructions, OAuth-only status, selected provider/session launch arguments and ready-only Auto selection. Pi identity persists in a separate roster; email, plan and usage remain unknown.
- SECURITY: (from @byokit/accounts 0.19.0) Isolate Pi credentials, settings and sessions in selected app-owned folders; scrub inherited provider keys and never pass TUI login instructions as model prompts, expose credentials, or refresh grants in status probes.
- FIX: (from @byokit/accounts 0.19.0) Explicitly adopt a selected found row's metadata into a new empty managed login. Preserve discovered/default folders and idempotently map `adoptedFrom` to the new identity, with existing cancellation semantics.
- FIX: (from @byokit/accounts 0.19.0) The PWA example asks one question at a time per card: Ask waits while an answer streams, a new Stop ends it, and an older answer's late text, final answer or failure can no longer overwrite a newer one.
- FIX: (from @byokit/accounts 0.19.0) The browser example now saves the sample usage page and its script with the offline shell, removes old shell caches on activation, and returns an explicit offline fallback for uncached pages and files. Sign-in and model calls still require the network.
- FIX: (from @byokit/accounts 0.19.0) A passing refusal at refresh (a 401, 403 or 429 that does not name the grant revoked) no longer deletes a sign-in: `recheck`, `access` and `keepFresh` keep it and try the stored grant again next time, for ChatGPT, device sign-ins and the Claude plan. Only the provider proving the grant revoked (`invalid_grant`, or OpenAI's `refresh_token_expired`/`refresh_token_reused`/`refresh_token_invalidated`) signs out.
- FIX: (from @byokit/accounts 0.19.0) Add explicit computer Claude browser, OpenRouter paste, Radius browser/device and Copilot Enterprise sign-ins through the pinned adapters. Claude paste stays the default; Radius billing is unknown and explicit-only. Qualify Kimi and Meta device flows with offline fixtures; portable-device runtime is unchanged.
- SECURITY: (from @byokit/accounts 0.19.0) Keep OpenRouter OAuth-issued API keys only in the owner-selected keyStore via shared key persistence, with non-secret route metadata and rollback on cancellation or failed index writes. Require explicit API billing selection before credentials; no plaintext fallback or ambient login import.
- FIX: (from @byokit/accounts 0.19.0) Add explicitly selected Node cloud accounts for Bedrock profiles/bearer tokens/SDK chain, Vertex ADC/picked service-account paths/API keys, Azure endpoints and Cloudflare API keys/Workers bindings; retain native typed Pi streams and honest unavailable route discovery.
- SECURITY: (from @byokit/accounts 0.19.0) Store keys exclusively through the member's keyStore, keep selected cloud paths/profiles as non-secret metadata, and isolate SDK requests from the app's default HOME/environment. Save/list/default operations never resolve cloud credentials or invoke bindings; browser/RN refuse before credential access. Bedrock skip-auth endpoints receive no AWS signature: stock Pi signs only the device-internal loopback hop with placeholder credentials, and the kit validates/strips that signature before egress. HTTP/1.1 only; no proxy/custom CA or endpoint Authorization header. Reserved/signing/hop-by-hop headers are dropped, not forwarded unchanged. No live endpoint qualification is claimed.
- FIX: (from @byokit/accounts 0.19.0) A refresh that gets no answer (a network failure) or a provider server error (5xx) no longer forces a new sign-in on phones and in browsers: the sign-in is kept and its stored grant is tried again on the next refresh. A refusal proving the grant revoked (`invalid_grant`), any other answer that may have spent the grant (including an accepted answer that cannot be read), or a failed save still asks to sign in again.
- FIX: (from @byokit/accounts 0.19.0) respond errors preserve HTTP status and Retry-After through account failure handling, allowing callers to retry 429 without adding request headers or other response headers to the error.

## 0.6.2 (2026-10-07)

- Dependency update: pins @byokit/link 0.7.1.

- Add an opt-in paired-host Jev backend over @byokit/link: the host holds the API key (billed per use), while phones receive probabilities and usage with typed pairing, connectivity and missing-key errors.
- SECURITY: answerer now uses the shared state-as-data guard and a delimited JSON data block, so untrusted
  on-screen text is separated from decision instructions. Apps using answerer should update; malformed model output still abstains.
- FIX: every answerer answer, including abstentions and failures, labels confidenceSource as self-reported.
- FIX: answerer retries HTTP 429 with the shared bounded backoff and Retry-After policy, respects aborts,
  and throws RateLimitError when its retry budget is exhausted; callback error details never enter decision reasons.
- Add typed answerer text options, including text.format JSON schemas, passed to the ask callback for accounts.respond.

- FIX: The Message desk example no longer labels a missing estimate as self-reported 0% confidence; unavailable answers show no estimate.
- Document the Message desk example for typed ChatGPT and Claude subscription decisions, self-reported confidence and human handoff below the floor.

## 0.6.1 (2026-10-02)

- Dependency update: pins @byokit/accounts 0.18.0.
- FIX: (from @byokit/accounts 0.18.0) The README no longer claims browsers can reach Claude's token endpoint directly; a web page sends it through the app's own server.
- FIX: (from @byokit/accounts 0.18.0) Discover every pinned provider and sign-in method with billing and platform readiness; qwen and MiniMax leave the default offer until their flows exist. Legacy provider IDs and explicit offer lists stay compatible.

## 0.6.0 (2026-10-01)

- Dependency update: pins @byokit/accounts 0.17.0.

- SECURITY: Backend failures no longer copy arbitrary exception messages into answer diagnostics, where private state or credentials could appear; only HTTP status, timeout, abort and cut-off diagnostics are retained.
- Add rank questions returning every candidate id in order with optional backend-reported scores; rules, OpenAI, answerer and the Node subscription adapter support explicit ordering, and Jev orders Choice probabilities as a documented fallback.
- Add opt-in personReason explanations separate from diagnostic reasons, with plain-text and length validation and no explanations on abstained answers.
- Add per-question state replacement, privacy narrowing and backend allowlists; scoped requests exclude shared state and other questions, stays-here questions never leave the device, and rules-only questions never reach a model.

## 0.5.3 (2026-10-01)

- Dependency update: pins @byokit/accounts 0.16.0.
- FIX: (from @byokit/accounts 0.16.0) Build device-owned secrets before accounts so API key routes compile in a fresh checkout.

## 0.5.2 (2026-10-01)

- Dependency update: pins @byokit/accounts 0.15.1.
- FIX: (from @byokit/usage 0.6.0) Claude subscription quota snapshots can now be read through an identity-free ephemeral host callback without credentials or a fabricated account UUID; readings never enter a cache or shared store, and retry state stays local to the source.

## 0.5.1 (2026-10-01)

- Dependency update: pins @byokit/accounts 0.15.0.

- FIX: openai({ auth: 'account' }) now accepts an Accounts ChatGPT subscription handle, so an existing Codex login needs no separate token-sharing session or API key (billed per use).

## 0.5.0 (2026-10-01)

- Dependency update: pins @byokit/accounts 0.14.0.

- Accept inline PNG/JPEG images for structured generation and the subscription CLI backend, using the shared image types; generation cache keys include canonical image bytes, MIME and IDs.

- Add named inline image inputs (bytes or data URLs with MIME) to decisions and evaluations, with
  image references in criteria, portable cache keys, and typed refusal for models without image support.
- Answerer-backed decisions preserve per-call usage and model rationales, including abstentions and
  cache hits; existing text-only answerers remain compatible. Subscription lanes stay host-owned;
  API key (billed per use) routes still require explicit opt-in.
- Add generic recorded answers and evaluateDecisions for image evals through the kit backend seam;
  offline replay remains the default.
- Add portable structured generation with local schema validation, complete-value results, model-separated caching, output budgets up to 16k tokens, and fixed failure messages.
- Add the Node-only `claude-code` adapter for an app-named unmodified binary and separate sign-in directory, labelled subscription with no API-key fallback. Tools, MCP, hooks and session persistence are disabled; tests use an offline fake binary.

## 0.4.7 (2026-10-01)

- Dependency update: pins @byokit/accounts 0.13.0.

## 0.4.6 (2026-09-30)

- Dependency update: pins @byokit/accounts 0.12.0.
- FIX: (from @byokit/accounts 0.12.0) fileStore verifies optional sealing-adapter upgrades and atomically replaces authenticated ciphertext on read, allowing opt-in dual-wrap migration without losing the original store on interruption.

## 0.4.5 (2026-09-30)

- Dependency update: pins @byokit/accounts 0.11.0.

## 0.4.4 (2026-09-30)

- Dependency update: pins @byokit/accounts 0.10.0.

## 0.4.3 (2026-09-30)

- Dependency update: pins @byokit/accounts 0.9.0.
- SECURITY: (from @byokit/accounts 0.9.0) Prevent replay of single-use refresh grants in the portable engine by saving a generation attempt before sending and committing the replacement before returning access. An uncertain or terminal attempt requires sign-in again; custom stores must provide a refresh transaction, and restart safety depends on durable storage and a single refresh owner or host lock.

## 0.4.2 (2026-09-30)

- Depends on @byokit/accounts 0.8.0.
- SECURITY: (from @byokit/accounts 0.8.0) Desktop fileStore now requires a sealing adapter, rejects insecure Electron storage backends, and refuses symlink or permissive credential files. Plaintext stores must revoke old credentials and sign in again; previously sealed stores remain readable with the same adapter.
- SECURITY: (from @byokit/accounts 0.8.0) Credential writes use exclusive random temporary files with no-follow opens and file sync before atomic replacement when Node permissions allow it; default sign-in and discarded-credential revoke logs no longer include raw provider errors or member identifiers.

## 0.4.1 (2026-09-30)

- FIX: (from @byokit/accounts 0.7.1) a cut-off answer is now reported as cut off: `respond` throws `IncompleteError` with its reason and partial output, and notifies `onEvent`, instead of returning it as finished.
- Depends on @byokit/accounts 0.7.1.

## 0.4.0 (2026-09-30)

- Add OpenAI general models used for typed decisions with Structured Outputs, self-reported probabilities,
  usage/raw responses and shared 429 retries. API key (billed per use) requires explicit opt-in; official
  consented account sessions use subscription billing. Add plain-object/JSON backend configuration and
  per-call overrides with backend/model/account cache separation.

## 0.3.0 (2026-09-29)

- FIX: Jev answers no longer drop the backend's token counts: every answer now carries `usage`
  (`input_tokens`/`output_tokens` when the backend sends them) and the raw backend response (`raw`), even
  when abstaining on a malformed answer. Any backend can report the same pair through its `Raw`.
- `decide()` takes an optional pluggable answer cache (`get`/`set`, sync or async): it computes a stable
  key (sha256 of the canonical request body, exported as `cacheKey`), reports `source: 'cache' | 'api'` on
  every answer, and serves a cached answer with the same `usage`/`raw` it was stored with. Ships the
  in-memory `MemoryCache` reference; no on-disk cache in the library.
- `jev()` retries 429s with backoff, honouring `Retry-After` when present (options `maxRetries` default 2,
  `retryBaseMs`, `retryMaxMs`; the total wait stays under `maxRetries` x `retryMaxMs`), respects the caller's
  timeout/`AbortSignal` including aborts mid-backoff, and never retries other statuses. Each retry is
  API key (billed per use) like the first call.

## 0.2.0

- `answerer({ name, leaves, ask })` makes a decision backend of any `(prompt, signal) => text`, such as the ChatGPT the person signed in to; any reply that is not the requested JSON is an abstain.
- The main entry is plain TypeScript with `fetch`, so it bundles for React Native and the web.

## 0.1.1

- The Apache-2.0 LICENSE ships in the tarball.

## 0.1.0

- Typed decisions with rules and Jev backends, abstaining below a confidence floor, and the `byokit-eval` runner.
