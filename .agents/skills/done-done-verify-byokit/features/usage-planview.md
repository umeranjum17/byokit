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

- **Write the consumer.** `"$scratch_dir/verify-usage-planview.mjs"` importing `demoView` from `../examples/usage-demo.ts` (type stripping runs `.ts` directly) and printing `JSON.stringify` of `demoView('codex')` and `demoView('claude')`.
- **Run and capture.** `feature=usage-planview; entry=@byokit/usage/view; drive=(node "$scratch_dir/verify-usage-planview.mjs")`, then run SKILL.md Evidence’s capture block. Exit code `0`.
- **Rate-limited honesty shows.** The codex view contains `room.left: "unknown"` and `quotaText` beginning with "The plan asked us to wait for a reading." — the selector refuses to invent a number.
- **Plan label and activity show.** The claude view has `label: "Claude plan"` and `activity.calls: 1` with `activity.tokens: 2400`, from the fixture call.

## Gotchas

- Import from `@byokit/usage/view` (or the demo module); never from `packages/usage/src`.
- `demoView` fixtures pin `nowMs`; do not compare its timestamps to wall-clock time.
- Pure selectors: no server to clean up — use SKILL.md Cleanup to remove only "$scratch_dir" and confirm the captured evidence survives.
