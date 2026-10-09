# Changelog

## Unreleased

## 0.20.0 (2026-10-09)

- FEAT: `Accounts.pick(member, selection, room?)` chooses the account and model a run should use over this member's real `list()` and `defaults()`, taking one reading per account and returning the same `AccountPick` as the portable `resolveSelection`; `Accounts.models(member, id)` lists one account's catalogue models with `available` and the word for why not (`resting` and `until`, `signed_out`, or `plan`). Both are read-only: neither writes the defaults nor the account index.

## 0.19.0 (2026-10-08)

- FIX: Add member-scoped custom OpenAI/Anthropic-compatible endpoints and explicit local presets using the pinned provider/model adapters. Billing is a required choice (or preset fact), never inferred from a hostname; Auto and Default refuse non-subscription accounts.
- SECURITY: Endpoint keys stay in the member's selected device key backend; loopback readiness precedes credentials, and endpoint models never enter another member or default runtime.
- SECURITY: Key-route accounts keep secrets only in the member's device-owned keyStore, with no plaintext or ambient credential fallback. Selected-key helpers override credential headers and explicitly refuse opaque SDK clients before secrets; unmodified typed native Pi pass-through remains available for explicit client-owned authentication.
- FIX: Key routes share account persistence and retain their pinned subscription or API key (billed per use) billing; non-subscription accounts are never an Auto or Default fallback.
- FIX: Portable key routes lazily load a reproducible split artifact of unmodified pinned Pi adapters; Google uses global fetch while preserving the upstream custom-fetch refusal.
- FIX: Browser and React Native key routes now opt in through `@byokit/accounts/keys` (`withKeys(portable)`), so the main portable entry no longer carries the adapters or vendor SDKs; without it, answering a key route reports `needs_keys` before any secret is read.
- SECURITY: repository CI temporarily excepts only npm braces GHSA-vfj7-8cjw-p6xm (affected <=3.0.3), accepting build-tool DoS risk from developer-config glob patterns, no user input, and no patched release; this is risk acceptance, not newly proved input safety or a shipped vulnerability fix. Remove by 2026-11-02 00:00 UTC; the gate fails at that deadline or as soon as authoritative GitHub metadata reports a patched version. Metadata failures fail closed. Valid npm dependency cycles count every reachable advisory; unrelated high/critical advisories and malformed reports still fail.
- FEATURE: Any provider the accounts catalogue gives RFC 8628 device data (`device` on its catalogue row: the client id and endpoints its own pinned client sends) signs in on a phone or in a browser with one implementation, alongside ChatGPT's own device flow. A new provider joins by catalogue data alone; `signInChoices` and `signable` are the picker's rows and the platform's answer, and `examples/pwa` renders a card per provider from them. `mockDevice()` stands in for any of them (`Accounts`' `deviceBase`).
- SECURITY: The device code, the poll and the refresh stay between the app and the provider's own endpoints; the stored credential is the OAuth pair Pi keeps, no token is logged, printed or written anywhere but the member's own store, and a provider without a documented revoke endpoint is simply not revoked.
- FIX: The Claude plan inference route no longer sends a frozen `claude-code/2.1.74` User-Agent that Anthropic answers with `signed_out`. The client value is the host's: pass `claudeUserAgent` (or a `headers` entry) and your value wins; with none passed, no client version is sent. A caller's header now overrides the route's defaults instead of the other way round.
- FIX: A Claude plan refresh that gets no answer or a server error keeps the sign-in and tries the same grant next time, instead of deleting it; only the provider proving the grant revoked (`invalid_grant`) removes it, and a grant that may be spent stays marked in the store so no process sends it again.
- FIX: Concurrent app processes wait for the fixed OAuth callback port before starting browser sign-in, instead of failing busy and asking the person to start again. Waiting respects cancellation and the sign-in deadline; callback state checks are unchanged.
- FIX: A device sign-in whose provider keeps its grant on refresh (no new refresh token, as Grok or Kimi may answer) now stays signed in instead of asking to connect again after its first refresh. Claude Pro/Max still requires a rotated grant.
- FIX: `fileStore` now serializes every write, a whole refresh included, across processes sharing its path through a `<path>.lock` file beside it, so two app processes refreshing one sign-in at once keep the fresh credential instead of spending a used grant and marking it for sign-in again; a crashed holder's lock is removed. A Claude plan refresh no longer reports expiry from another process's refresh in flight.
- The stand-in OpenAI signs in as Umer (`umer@example.com`), so the example apps, their README pictures and the accounts tests all show the same demo person.
- FIX: A person signs in once per computer: new `machineStore(member, seal)` (Node entry) keeps each person's sealed sign-ins at one conventional path every app shares (`~/.local/share/byokit/people/<member>/auth.json`, `~/Library/Application Support/byokit/...` on macOS, `AppData\Roaming\byokit\...` on Windows), so a second app holding the same seal, such as `osKeyringSeal({ service: 'byokit' })`, is signed in already. Breaking: `Accounts` no longer falls back to an in-memory store that loses every sign-in at restart; pass `store`, and `memoryStore()` only when sign-ins should end with the app. The decide-plan and realtime-voice examples now keep sign-ins at the machine store.
- FIX: Manage named native Pi 0.87.1 subscription accounts with TUI sign-in instructions, OAuth-only status, selected provider/session launch arguments and ready-only Auto selection. Pi identity persists in a separate roster; email, plan and usage remain unknown.
- SECURITY: Isolate Pi credentials, settings and sessions in selected app-owned folders; scrub inherited provider keys and never pass TUI login instructions as model prompts, expose credentials, or refresh grants in status probes.
- FIX: Explicitly adopt a selected found row's metadata into a new empty managed login. Preserve discovered/default folders and idempotently map `adoptedFrom` to the new identity, with existing cancellation semantics.
- FIX: The PWA example asks one question at a time per card: Ask waits while an answer streams, a new Stop ends it, and an older answer's late text, final answer or failure can no longer overwrite a newer one.
- The PWA example's account rows no longer repeat the plan as a pill on every row; each row keeps its address, usage bar and room.
- The example page lists every connected plan and key before the Add rows, each
  with a plain billing chip and a live room-left meter with its refill time.
- Ask runs on one account chosen at run start: Auto takes the most room and
  names the account and why; the picker also switches accounts by hand, and a
  run never switches account mid-stream.
- FIX: The browser example now saves the sample usage page and its script with the offline shell, removes old shell caches on activation, and returns an explicit offline fallback for uncached pages and files. Sign-in and model calls still require the network.
- FEATURE: The PWA example's sign-in cards now show each provider with a logo tile and an honest billing chip (plan, or pay-per-use), a device-code well with one-tap copy and a live countdown, `Open <name>` as the single primary action with Cancel secondary, a connected card with the plan badge and a quiet Sign out, and styled expired and error banners, in light and dark at phone and desktop widths.
- FIX: A passing refusal at refresh (a 401, 403 or 429 that does not name the grant revoked) no longer deletes a sign-in: `recheck`, `access` and `keepFresh` keep it and try the stored grant again next time, for ChatGPT, device sign-ins and the Claude plan. Only the provider proving the grant revoked (`invalid_grant`, or OpenAI's `refresh_token_expired`/`refresh_token_reused`/`refresh_token_invalidated`) signs out.
- FIX: Add explicit computer Claude browser, OpenRouter paste, Radius browser/device and Copilot Enterprise sign-ins through the pinned adapters. Claude paste stays the default; Radius billing is unknown and explicit-only. Qualify Kimi and Meta device flows with offline fixtures; portable-device runtime is unchanged.
- SECURITY: Keep OpenRouter OAuth-issued API keys only in the owner-selected keyStore via shared key persistence, with non-secret route metadata and rollback on cancellation or failed index writes. Require explicit API billing selection before credentials; no plaintext fallback or ambient login import.
- FIX: Add explicitly selected Node cloud accounts for Bedrock profiles/bearer tokens/SDK chain, Vertex ADC/picked service-account paths/API keys, Azure endpoints and Cloudflare API keys/Workers bindings; retain native typed Pi streams and honest unavailable route discovery.

- SECURITY: Store keys exclusively through the member's keyStore, keep selected cloud paths/profiles as non-secret metadata, and isolate SDK requests from the app's default HOME/environment. Save/list/default operations never resolve cloud credentials or invoke bindings; browser/RN refuse before credential access. Bedrock skip-auth endpoints receive no AWS signature: stock Pi signs only the device-internal loopback hop with placeholder credentials, and the kit validates/strips that signature before egress. HTTP/1.1 only; no proxy/custom CA or endpoint Authorization header. Reserved/signing/hop-by-hop headers are dropped, not forwarded unchanged. No live endpoint qualification is claimed.
- FIX: A refresh that gets no answer (a network failure) or a provider server error (5xx) no longer forces a new sign-in on phones and in browsers: the sign-in is kept and its stored grant is tried again on the next refresh. A refusal proving the grant revoked (`invalid_grant`), any other answer that may have spent the grant (including an accepted answer that cannot be read), or a failed save still asks to sign in again.

- FIX: respond errors preserve HTTP status and Retry-After through account failure handling, allowing callers
  to retry 429 without adding request headers or other response headers to the error.

## 0.18.0 (2026-10-02)

- Dependency update: pins @byokit/usage 0.7.0.

- The README points to the shared account-route vocabulary (D18); pinned discovery metadata does not imply additional implemented authentication flows.
- Name the Claude plan: `plan(member, 'claude')` reads it once per sign-in from Claude's profile with the stored access, never refreshing it (an empty plan, never a failure, when it doesn't say); `planLabel` says "ChatGPT Plus" or "Claude Max". The PWA and Expo examples sign in to Claude by its page and pasted code, show a connected card naming the plan, and stream an answer.
- FIX: The README no longer claims browsers can reach Claude's token endpoint directly; a web page sends it through the app's own server.
FIX: Discover every pinned provider and sign-in method with billing and platform readiness; qwen and MiniMax leave the default offer until their flows exist. Legacy provider IDs and explicit offer lists stay compatible.

## 0.17.0 (2026-10-01)

- Dependency update: pins @byokit/usage 0.6.1.

- SECURITY: Restrict ChatGPT host access to ChatGPT subscription accounts before opening a credential runtime; a different provider id cannot select or expose its grant.
- FIX: Managed CLI subscription rows with no supplied provider executable report not_included, so list and Auto remain available for other providers without touching the unavailable row's credentials or sign-in markers.
- Add independent subscription accounts per member, fresh sign-in, identity replacement, account names and defaults.
- Add a read-only nativePiAccount launch/session descriptor for independent app-owned Pi folders, qualified against native Pi 0.87.1. This does not share subscription grants, sign in, infer readiness or add Pi to managed Auto; found rows remain read-only and reconnect uses the person's normal provider-native UI outside the kit.

- SECURITY: Add launchEnv to scrub inherited provider credentials, including subscription tokens and API key (billed per use) variables; isolate now prepares only the app folder and never mutates process.env. Apps must pass launchEnv().env when spawning a child.

## 0.16.0 (2026-10-01)

- FIX: Build device-owned secrets before accounts so API key routes compile in a fresh checkout.
- Add opt-in member OpenAI, TypeSafe and OpenRouter API key (billed per use) routes,
  stored through device-owned secrets stores with redacted outcomes and decide handoff.

## 0.15.1 (2026-10-01)

- Dependency update: pins @byokit/usage 0.6.0.
- FIX: (from @byokit/usage 0.6.0) Claude subscription quota snapshots can now be read through an identity-free ephemeral host callback without credentials or a fabricated account UUID; readings never enter a cache or shared store, and retry state stays local to the source.

## 0.15.0 (2026-10-01)

- Dependency update: pins @byokit/usage 0.5.0.

- FIX: ChatGPT subscription respond() now retains reported token usage with result: true or tools, including partial results for incomplete answers.
- Bind an existing ChatGPT subscription login to a member-bound chatgpt() handle without exposing credentials.
- Script mockOpenAI answers with string, regex or function prompt matchers and optional token usage.

## 0.14.0 (2026-10-01)

- Dependency update: pins @byokit/usage 0.4.0.

- SECURITY: Add a Node-only managed CLI account boundary for subscription sign-in: only app-owned folders and explicitly passed absolute binaries, no default login access, no credential-file reads, no token output, and launch environment credential shedding.
- Add managed CLI account creation, marker-gated sign-in, status, rename, cancellation, history links and removal, with legacy roster and terms compatibility.
- Share the portable chooser's AccountLike type and accept normalized subscription usage with millisecond reset times.
- Bound native status deadlines even when a passed CLI ignores termination; stdout is capped and only the owned child is terminated.
- Offer every subscription catalogue row by default on supported platforms, adding Kimi, Meta, Qwen and MiniMax labels; preserve Claude Pro/Max sign-in and remove terms and visibility gates. API key (billed per use) rows remain opt-in. Simplify the ChatGPT plan-use error words.

## 0.13.0 (2026-10-01)



- Add portable, choose-once multi-account selection with most-room ordering, unknown room above exhausted, and secret-free candidate explanations. Auto and default fallback use subscription accounts only; an API key (billed per use) must be explicitly selected.
- Export roomOf and roomWords, shared Auto conformance fixtures, and descriptive multi-account terms data.

## 0.12.0 (2026-09-30)



- FIX: fileStore verifies optional sealing-adapter upgrades and atomically replaces authenticated ciphertext on read, allowing opt-in dual-wrap migration without losing the original store on interruption.
- Claude Pro/Max subscription PKCE sign-in, direct Messages and single-flight refresh with on-device credentials.

- Anthropic Messages with an app-passed API key (billed per use), explicit model and opt-in; typed native requests, streamed text/tools/thinking/message events, usage/raw results and the shared IncompleteError contract for max_tokens/refusal (including with tools) on every platform.
- Expose fresh subscription access to host-side capabilities using the app’s own sign-in.

## 0.11.0 (2026-09-30)



- Add optional `parallelToolCalls` to `respond` and `Accounts.respond`, passed through to ChatGPT as `parallel_tool_calls`; omitted keeps the provider default.

## 0.10.0 (2026-09-30)



- Export portable `classifyFailure` and `Failure`, with an injectable clock and `REST_MS` fallbacks; retain `classify` as an alias.

## 0.9.0 (2026-09-30)



- SECURITY: Prevent replay of single-use refresh grants in the portable engine by saving a generation attempt before sending and committing the replacement before returning access. An uncertain or terminal attempt requires sign-in again; custom stores must provide a refresh transaction, and restart safety depends on durable storage and a single refresh owner or host lock.

## 0.8.0 (2026-09-30)

- SECURITY: Desktop fileStore now requires a sealing adapter, rejects insecure Electron storage backends, and refuses symlink or permissive credential files. Plaintext stores must revoke old credentials and sign in again; previously sealed stores remain readable with the same adapter.
- SECURITY: Credential writes use exclusive random temporary files with no-follow opens and file sync before atomic replacement when Node permissions allow it; default sign-in and discarded-credential revoke logs no longer include raw provider errors or member identifiers.

## 0.7.1 (2026-09-30)

- FIX: a cut-off answer is now reported as cut off: `respond` throws `IncompleteError` with its reason and partial output, and notifies `onEvent`, instead of returning it as finished.

## 0.7.0 (2026-09-30)

- Add the portable `chatgptPlan` adapter for a host-validated official token-sharing session, checking
  ChatGPT plan usage consent on every access. Uses subscription billing and never falls back to an API key
  (billed per use); the host owns sign-in, identity verification, storage and refresh per person.

## 0.6.0 (2026-09-30)

- `respond` and `Accounts.respond` accept `originator` (or set it once on `Accounts`): the app's own originator header value. Default: 'byokit', as before.
- FIX: a garbled streamed answer no longer arrives as an empty string with HTTP 200: a data line the parser cannot read now throws a ResponseError the app can show.
- FIX: a stream that ends with no words, no completed answer and no tool calls now throws instead of resolving to an empty string.
- FIX: the answer is the words as they streamed in; the completed envelope is only used when nothing streamed. Apps whose completed envelope carries no text no longer see their streamed words replaced by an empty answer.
- FIX: streamed answers split on bare-CR line endings too, so a backend that separates events with carriage returns no longer yields an empty answer.

- `respond` passes the whole question through: a message array (many turns, pictures with `input_image`, a `function_call` with its `function_call_output`), `tools` and `tool_choice` (the app's own function tools and built-ins, including `image_generation`), how hard the model thinks (`reasoning.effort`), and how long the answer is with the shape it must follow (`text.verbosity`, `text.format`). With `tools` the result is the text with every output item (`isFunctionCall` spots a call); without, the plain text as before. `onEvent` sees each tool call and output item as it streams.

## 0.4.1 (2026-09-29)

- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.

## 0.4.0

- Each catalogue row carries its billing (`subscription`, `api`); show `billingWords(p)` next to every provider you list.
- FIX: OpenRouter (API billing) is no longer offered by default on computers; `offered()` without keys returns subscription rows only. Name it explicitly (`offer: ['openrouter']`) to keep offering it.
- FIX: a locked-keychain read (iOS returns "User interaction is not allowed" while the phone is locked) no longer signs the person out: `keepFresh` treats it as unknown and tries later, only a refused refresh fires `onExpired`.
- `secureStore(secure, name, options?)` passes `options` (e.g. `{ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }`) to every keychain get, set and delete; the default is unchanged.

## 0.3.1

- `respond(member, { instructions, input, onText })` asks ChatGPT with the member's own sign-in, the answer streaming in over an injected `fetch` (whole answer at once when the fetch can't stream); limits and lapsed sign-ins are acted on as `failed()` does.
- FIX: a plain HTTP 429 or an undated `rate_limit_exceeded` is a temporary rate limit, not "plan doesn't include this"; a streamed error keeps its code.
- FIX: a refresh that fails on the network before asking is reported as network trouble; a refused refresh signs the account out.

## 0.3.0

- FIX: `@byokit/accounts/testing` `decoy()` now requires a caller-owned root; migrate from `decoy()` to `decoy(root)` and clean up that root when done.
