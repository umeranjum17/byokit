# Accounts key route on a Hermes runtime

A consumer app on React Native / Hermes answers a key route (`openrouter:key`) through the built portable `@byokit/accounts`, even though Hermes does not ship `AbortSignal.prototype.throwIfAborted` — the one AbortSignal method Pi's auth resolution used unconditionally.

## Sub-features

- `hermes-stream`: with `AbortSignal.prototype.throwIfAborted` deleted (Hermes), `respondKey` for `openrouter:key` streams the model's answer back over a local OpenAI-compatible server.
- `hermes-aborted`: with the method deleted, an already-aborted signal still rejects the route as `aborted` and dispatches no request.

## How to get to it (user POV)

On a phone built with Hermes, ask the app's key route a question. It used to fail before any request with "This account could not answer. Try again." because Pi called a method Hermes lacks; now the answer comes back and cancelling still cancels.

## Driving it with node scratch consumers

There is no scratch consumer: the built artifact is driven by a maintained Node test that imports the built portable/browser entry (`packages/accounts/dist/portable.js` and `dist/keys.js`) exactly as a browser or React Native consumer resolves it.

Preconditions: baseline (features/README.md), including a completed `npm run build` (the test imports `dist/`).

```bash
feature=accounts-hermes-throwifaborted
entry=packages/accounts/test/hermes-throwifaborted.test.ts
drive=(node --max-old-space-size=2048 --test packages/accounts/test/hermes-throwifaborted.test.ts)
```

Run the SKILL.md Evidence block. The test deletes `AbortSignal.prototype.throwIfAborted`, runs `new Accounts({...}, withKeys(portable))` against a local `127.0.0.1` OpenAI-compatible SSE server, adds an `openrouter:key` account with a fake key, and calls `respondKey`. Exit 0 requires both tests; the `hermes-stream` leg prints the streamed text and usage, the `hermes-aborted` leg the aborted rejection and zero requests.

Regression: the same test exits 1 with `KeyRouteError: This account could not answer. Try again.` against a build that has not applied the guard (`packages/accounts/src/pi` bundled without it).

## Gotchas

- The test must load the **built** portable runtime (`dist/`), not the published Pi runtime: on Node the published Pi works because V8 has the method, so only the bundled route reproduces the gap.
- `throwIfAborted` must stay deleted for the whole request (the test awaits inside the deleted window); restoring it before the fetch hides the bug.
- Loopback only (`127.0.0.1`, ephemeral port); the fake key is a fixture, never a real credential.
- The bundle patch is recorded in `packages/accounts/src/pi/PROVENANCE.json` (`patch`) and is re-applied by `scripts/gen-accounts-pi.ts` on every regenerate, so a Pi pin bump keeps it. Regenerate with `node scripts/gen-accounts-pi.ts`.
