# Two ChatGPT engine-OAuth accounts (producer acceptance 1–4)

One built public-entry consumer drives two synthetic ChatGPT OAuth principals through independent account agents on the loopback fake Gateway. It covers distinct final stores, identity conflicts, busy/cancellation, expiry/restart, unknown and revoked readiness, exact-account runs, account-specific rest persistence, and the absence of credential adoption. No real sign-in, credentials, provider network, or quota inference is involved.

## Drive

From the repository root after the verify skill's Launch and Doctor:

```bash
done-done verify openclaw-two-openai-accounts --outcome "Two synthetic ChatGPT engine-OAuth accounts remain isolated through sign-in, account-specific status and logout, exact-account runs, uncertain/revoked readiness, rate limits and restart; no real sign-in or credential was used."
```

The capture uses only `@byokit/openclaw` and `@byokit/openclaw/testing`, resolves the built `packages/openclaw/dist` entry, and writes `result.json` and `steps.json` to the done-done evidence directory. The done-done run retains the command output and judged receipt.

## Limits

The fake Gateway supplies deterministic OAuth identities and engine state; it does not prove provider OAuth, real subscription quota, or provider-side revocation. Rate-limit behavior is the engine's deterministic limit response. The route is not thereby declared generally multi-account-capable.
