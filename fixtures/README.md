# Conformance fixtures

The shared fixtures, including `revoke.json`, are the frozen `byokit-android` Kotlin baseline. TypeScript-only additions live in `*-typescript.json`; `@byokit/accounts` tests apply those alongside the shared cases (replacing a shared HTTP case with the same body where needed). Change a rule in its owning fixture first.

The shared data itself has one copy, `packages/accounts/src/catalogue.json` and `words.json`; the Kotlin build bundles
those same files. Catalogue conformance checks the explicit Anthropic API billing and opt-in labels without adding
a Messages backend to the frozen Kotlin runtime.

| File | What it is |
|---|---|
| `conformance/member-keys-typescript.json` | TypeScript-only explicit member API-key consent, billing, sealing and redaction rules. |
| `conformance/claude-messages-typescript.json` | TypeScript-only native Claude Messages stream captures. |
| `conformance/computer-signins-typescript.json` | Pinned computer browser/paste and RFC 8628 flows; controlled loopback fixtures, explicit billing and secret-store canaries. No portable-device or live qualification. |
| `conformance/claude-plan-typescript.json` | TypeScript-only Claude subscription PKCE, strict state, exchange and refresh rules (offline protocol captures). |
| `conformance/signin-errors.json` | A failed sign-in's message → the `words.json` key to show. |
| `conformance/classify.json` | A model-call failure message → `rate_limit`, `overloaded`, `signed_out`, `network` or none, plus "resting until". |
| `conformance/limit-responses.json` | Shared ChatGPT HTTP error (status + body) → kind, until, message. |
| `conformance/limit-responses-typescript.json` | TypeScript-only plan exclusion and HTTP status/Retry-After metadata for caller retries. |
| `conformance/token-responses.json` | A token response → the stored credential (same shape as pi-ai's `{type:"oauth",access,refresh,expires,accountId}`). |
| `conformance/refresh-typescript.json` | TypeScript portable refresh: before-send attempt state, committed rotation, and no replay after uncertainty or terminal refusal. |
| `conformance/device-code.json` | Device-code start and poll responses → parsed result. |
| `conformance/paste.json` | What a person pastes back ("Having trouble?") → code and state. |
| `conformance/revoke.json` | Signing out → the one revoke request sent to ChatGPT (or none), and the sign-in deleted whatever it answers. |
| `conformance/sse.json` | Shared streamed ChatGPT answer → its text, or the error it ended with. |
| `conformance/sse-typescript.json` | TypeScript-only completion requirement, authoritative output, and coded SSE limits. |
| `conformance/incomplete-typescript.json` | TypeScript-only cut-off answers: typed error, partial output, and incomplete event for SSE and JSON. |
| `conformance/infer-typescript.json` | Pinned official default native text-model asset and tokenizer/context expectations; not a physical acceptance claim. |
| `conformance/dictation-typescript.json` | Stable live partials, final-only corrections, silence and cancellation. |
| `conformance/anthropic-sse-typescript.json` | Recorded Messages SSE, usage, tools/thinking, truncation, refusal and protocol errors (TypeScript only). |
| `conformance/usage-typescript.json` | TypeScript quota normalization and account Auto input contract: hard blocks, scope, age and poll failures. |
| `conformance/plain-words.json` | The pattern no sentence in `words.json` may match. |
| `conformance/auto-pick-typescript.json` | TypeScript portable Auto/default/explicit selection, demand, age, explanations and deterministic ranking; shared with runtime kits. |
| `conformance/identity-reauth-typescript.json` | TypeScript identity ownership and re-authentication boundaries; engine-owned adoption, chooser consumes validated records. |
| `conformance/cloud-accounts-typescript.json` | TypeScript-only selected cloud metadata, save/list/default isolation, binding readiness and B3/B4 tuple ownership. Checked by `packages/accounts/test/cloud.test.ts`. |
| `conformance/account-keys-typescript.json` | TypeScript-only B2 source-pinned closure of 24 wrapped key tuples; lifecycle, billing and adapter limits, not live qualification. Checked by `packages/accounts/test/key-routes.test.ts`. |
| `conformance/pi-streams.json` | Valid synthetic Pi-pin adapter wire formats: text, tool call and usage for all seven portable adapters. Differential success/400/abort tests assert real success, including Google global fetch; cold Metro and strict packed key probes share the two compatibility families. No live vendor/device claim. |
| `conformance/account-routes-typescript.json` | TypeScript-only D18 account routes: vocabulary, default iff subscription, explicit billing (never from an address), readiness before credentials, complete discovery, excluded mechanisms. Checked by `packages/ui-core/test/account-routes.test.ts`. |
| `conformance/link-frames-typescript.json` | TypeScript link transport rejects missing kinds, unknown kinds and truncated stream ids. |

Each fixture file states its rule in `rule`; `now` (epoch ms) is the fixed clock for time-dependent cases.

`account-identities-typescript.json` fixes WP1 identity addition/replacement and non-secret index rules for the TypeScript kit; the frozen Kotlin mirror does not implement this feature.
