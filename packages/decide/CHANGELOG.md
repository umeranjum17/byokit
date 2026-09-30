# Changelog

## Unreleased

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
