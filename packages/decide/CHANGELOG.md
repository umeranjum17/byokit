# Changelog

## Unreleased

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
