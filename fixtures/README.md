# Shared data and conformance fixtures

Every byokit implementation (`@byokit/accounts` in TypeScript, `byokit-android` in Kotlin) reads the same data from this
folder and must pass the same fixtures. Change a rule here first; both test suites then fail until they agree.

| File | What it is |
|---|---|
| `catalogue.json` | The AI accounts a person can bring: name, terms status, sign-in flows per platform, default models. Claude is absent on purpose. |
| `words.json` | Every sentence a person sees, with `{name}`, `{vendor}`, `{code}`, `{time}` placeholders. |
| `conformance/signin-errors.json` | A failed sign-in's message → the `words.json` key to show. |
| `conformance/classify.json` | A model-call failure message → `rate_limit`, `overloaded`, `signed_out`, `network` or none, plus "resting until". |
| `conformance/limit-responses.json` | A ChatGPT HTTP error (status + body) → kind, until, message. |
| `conformance/token-responses.json` | A token response → the stored credential (same shape as pi-ai's `{type:"oauth",access,refresh,expires,accountId}`). |
| `conformance/device-code.json` | Device-code start and poll responses → parsed result. |
| `conformance/paste.json` | What a person pastes back ("Having trouble?") → code and state. |
| `conformance/sse.json` | A streamed ChatGPT answer → its text, or the error it ended with. |
| `conformance/plain-words.json` | Words that must never appear in `words.json`. |

Each fixture file states its rule in `rule`; `now` (epoch ms) is the fixed clock for time-dependent cases.
