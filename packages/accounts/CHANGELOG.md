# Changelog

## Unreleased

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
