# Conformance fixtures

The shared fixtures, including `revoke.json`, are the frozen `byokit-android` Kotlin baseline. TypeScript-only additions live in `*-typescript.json`; `@byokit/accounts` tests apply those alongside the shared cases (replacing a shared HTTP case with the same body where needed). Change a rule in its owning fixture first.

The shared data itself has one copy, `packages/accounts/src/catalogue.json` and `words.json`; the Kotlin build bundles
those same files.

| File | What it is |
|---|---|
| `conformance/signin-errors.json` | A failed sign-in's message → the `words.json` key to show. |
| `conformance/classify.json` | A model-call failure message → `rate_limit`, `overloaded`, `signed_out`, `network` or none, plus "resting until". |
| `conformance/limit-responses.json` | Shared ChatGPT HTTP error (status + body) → kind, until, message. |
| `conformance/limit-responses-typescript.json` | TypeScript-only plan exclusion: `usage_not_included` remains distinct from a rate limit. |
| `conformance/token-responses.json` | A token response → the stored credential (same shape as pi-ai's `{type:"oauth",access,refresh,expires,accountId}`). |
| `conformance/device-code.json` | Device-code start and poll responses → parsed result. |
| `conformance/paste.json` | What a person pastes back ("Having trouble?") → code and state. |
| `conformance/revoke.json` | Signing out → the one revoke request sent to ChatGPT (or none), and the sign-in deleted whatever it answers. |
| `conformance/sse.json` | Shared streamed ChatGPT answer → its text, or the error it ended with. |
| `conformance/sse-typescript.json` | TypeScript-only completion requirement, authoritative output, and coded SSE limits. |
| `conformance/plain-words.json` | The pattern no sentence in `words.json` may match. |

Each fixture file states its rule in `rule`; `now` (epoch ms) is the fixed clock for time-dependent cases.
