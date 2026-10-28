# Phone-only key model resolution

Source: `packages/accounts/src/{keys,portable-keys,key-models,named-model}.ts`, generated `routes.json` and `scripts/gen-accounts-{pi,routes}.ts`.

## Launch and drive

Build first (`npm ci` in a fresh checkout, `npm run build`). From a clean committed tree:

```sh
done-done run accounts-rn-models
```

The journey runs `node --conditions=react-native .agents/skills/done-done-verify-byokit/capture/accounts-rn-models.mjs`; the consumer imports the repository's egress guard before the SDK.
It imports the built **public** `@byokit/accounts/keys` and `@byokit/accounts` RN exports, constructs Models with app-owned auth context and no supplied providers, resolves `google/gemma-4-31b-it:free` from an OpenRouter-shaped live HTTP list on loopback, then receives `Hello Umer` through the real pinned portable adapter. The consumer supplies a synthetic explicit key; no account, external network, model or default credential lookup.

It also drives missing-list/offline fallback, unknown-provider and blank-id refusal, missing-key error, unchanged `openrouter:key` API billing, and zero ambient auth reads. No catalogue anchors or bundled model-ID list are supplied. Route capabilities are generated from the pin; live input modalities narrow them. Unpriced fallback is **not** free billing.

## Evidence

`rn-models.log` records real SDK output and missing-key error. `steps.json` records the consumer journey. Both belong to this run only under `$DONE_DONE_EVIDENCE_ROOT`; seal and judge them with done-done before claiming proof.

Portable bundling coverage in `packages/accounts/test/portable.test.ts` and `key-routes.test.ts` checks that the explicit keys graph uses only kit-owned Pi artifacts and the default graph remains SDK-free.

## Boundaries

This is built-JavaScript RN-export qualification on Node, not a Hermes device, Metro app, native Android/iOS or real vendor generation claim. There is no changed screen, theme, width or interaction to capture.
