# Usage preflight

A consumer app asks `@byokit/usage` what a call could cost and how much of a person's allowance is left before it sends the call, so the person can decline; nothing is sent or recorded until the caller decides.

## Sub-features

- `preflight-ceiling`: the cost ceiling comes from the app's own price row at the request's full output allowance, with every input token at the dearest input rate, and is marked `ceiling: true`.
- `preflight-allowance`: the seven-day token allowance is reported as its remaining/cap pair, as `uncapped`, or as an explicit unknown; the caller's over-budget call is flagged with `exceeds: true`.
- `preflight-unknown`: no price, a subscription/API billing mismatch, unbounded output and invalid rates (including negative input, cached, cache-write and output rates) return `{ amount: 'unknown', reason }`, never a bundled or default rate.
- `preflight-decline`: the caller declines a costly call and the accounts client sends nothing and records nothing.

## How to get to it (user POV)

- The consumer imports `preflight` from `@byokit/usage` (the same export is on the React Native entry), builds `prices` and the `allowance` week from its own data, optionally passes `room` from `roomOf`, and calls it before `account.respond(...)`. Preflight is a pure, side-effect-free estimator: it never sends the call.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-usage-preflight.mjs"` importing `{ preflight, tokenLedger, callLedger, memoryTokenLedgerStore }` from `@byokit/usage` and `{ anthropic }` from `@byokit/accounts`. Build an app price row and a `tokenLedger({ store, cap: 1000 })` with one recorded call, then define `ask(max_tokens)` that calls `preflight({ provider, model, billing: 'api', inputTokens, maxOutputTokens }, { prices, allowance, room })`, refuses to send when `exceeds !== false`, and otherwise calls `account.respond(...)` with a counting `fetch` and records the result.
- **Run and capture.** `feature=usage-preflight; entry=@byokit/usage; drive=(node "$scratch_dir/verify-usage-preflight.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Costly call declined.** The 800-token ceiling is `cost.amount` `0.012375` and `ceiling: true`, `allowance.remaining` is `700`, and `exceeds` is `true`; the caller declines, so the counting `fetch` shows `0` requests. The affordable 500-token call then shows `exceeds: false` and, once accepted, `1` request with the week's remaining down to `560`.
- **Unknown stays explicit.** An unpriced provider returns `{ amount: 'unknown', reason: 'no-price' }` with `exceeds: 'unknown'`; a negative input rate returns `{ amount: 'unknown', reason: 'invalid-price' }`; a bad input throws a typed `TokenLedgerError` instead of a number.

## Gotchas

- Import from `@byokit/usage` (or the React Native entry); never from `packages/usage/src`.
- Preflight carries no prices: `cost` is `unknown` with a reason unless the app passes its own matching price row. Treat `unknown` as "the person decides", never as room.
- Output tokens are unseen before the call, so the price is a ceiling, not a point estimate; `room` only appears on a subscription call.
- Pure estimator: no server to clean up — use SKILL.md Cleanup to remove only "$scratch_dir" and confirm the captured evidence survives.
