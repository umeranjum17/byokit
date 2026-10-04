# Usage plan view

A consumer app renders a person's plan view — label, room left, quota and activity text — from call records and a quota reading, via `@byokit/usage`'s public selectors. `examples/usage-demo.ts` is the repo's fixture module for exactly this.

## Sub-features

- `plan-label`: the view names the person's plan.
- `plan-rate-limited`: a rate-limited reading renders "unknown" room, not a fake percentage.
- `plan-activity`: call records roll up into token/activity counts.

## How to get to it (user POV)

- The consumer imports `planView` from `@byokit/usage/view` and passes `{ provider, account, calls, quota }`, as in `examples/usage-demo.ts` (`demoView(provider)`).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `scratch/verify-usage-planview.mjs` importing `demoView, providers` from `./examples/usage-demo.ts` (type stripping runs `.ts` directly) and printing `JSON.stringify` of `demoView('codex')` and `demoView('claude')`.
- **Run and capture.** `node scratch/verify-usage-planview.mjs 2>&1 | tee .verify-artifacts/usage-planview/drive.txt; echo "EXIT=$?"`. Exit code `0`.
- **Rate-limited honesty shows.** The codex view contains `"left":"unknown"` and an `outcome:"rate-limited"` poll — the selector refuses to invent a number.
- **Plan label shows.** The claude view's `label` names the plan; activity derives from the fixture calls.

## Gotchas

- Import from `@byokit/usage/view` (or the demo module); never from `packages/usage/src`.
- `demoView` fixtures pin `nowMs`; do not compare its timestamps to wall-clock time.
- Pure selectors: no server to clean up — cleanup is `rm -rf scratch/` as usual.
