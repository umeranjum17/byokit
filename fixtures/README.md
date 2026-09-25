# Conformance fixtures

Every byokit implementation (`@byokit/accounts` in TypeScript, `byokit-android` in Kotlin) must pass these cases. Change
a rule here first; the implementations' tests then fail until they agree.

The shared data itself has one copy, `packages/accounts/src/catalogue.json` and `words.json`; the Kotlin build bundles
those same files.

| File | What it is |
|---|---|
| `conformance/signin-errors.json` | A failed sign-in's message → the `words.json` key to show. |
| `conformance/classify.json` | A model-call failure message → `rate_limit`, `overloaded`, `signed_out`, `network` or none, plus "resting until". |
| `conformance/limit-responses.json` | A ChatGPT HTTP error (status + body) → kind, until, message. |
| `conformance/token-responses.json` | A token response → the stored credential (same shape as pi-ai's `{type:"oauth",access,refresh,expires,accountId}`). |
| `conformance/device-code.json` | Device-code start and poll responses → parsed result. |
| `conformance/paste.json` | What a person pastes back ("Having trouble?") → code and state. |
| `conformance/sse.json` | A streamed ChatGPT answer → its text, or the error it ended with. |
| `conformance/plain-words.json` | The pattern no sentence in `words.json` may match. |

Each fixture file states its rule in `rule`; `now` (epoch ms) is the fixed clock for time-dependent cases.
