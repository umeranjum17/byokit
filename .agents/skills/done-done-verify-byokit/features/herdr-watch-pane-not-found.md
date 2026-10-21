# Herdr status watch on a closed pane: refresh finishes

When an agent pane closes, Herdr answers that pane's status watch with a `pane_not_found` error frame
whose id may be `""`, the request id, `null` or absent. The kit counts every such frame as the watch's
refusal: it logs `herdr: status subscription rejected: pane_not_found: ...`, drops the watch, and
`kit.refresh()` resolves instead of waiting forever for an ack that never comes (muxr's pane attach hung
on it). A rejected watch is not retried.

## Sub-features

- `null-id`: a watch answered `pane_not_found` with a `null` id (before the fix: `refresh()` never settles).
- `omitted-id`: the same with no `id` key at all (before the fix: never settles).
- `empty-and-request-id`: the same with `""` and with the request's own id (always settled).

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, onLog })`, `await kit.start()`,
  then `fake.rejectWatch(<agent pane id>, <id shape>)` and `await kit.refresh()` (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in serves a
real Unix socket under the scratch directory and answers `pane_not_found` over it.

- **Write the consumer.** `"$scratch_dir/verify-herdr-watch-pane-not-found.mjs"` importing `HerdrKit` from
  `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. For each id shape in
  `['null', 'omitted', 'empty', 'request']`: start a fake (own scratch `dir`) and a kit with an `onLog` that
  collects lines, `await kit.start()`, find the pane whose `agent` is set in `kit.snapshot()`,
  `fake.rejectWatch(paneId, shape)`, then race `kit.refresh()` against a 3 s timer. Print one line per shape:
  `<shape>: refresh settled in <ms> ms, log: <the pane_not_found line>`. Exit non-zero if any shape times out
  or logs no `pane_not_found`; `await kit.stop()` and `await fake.stop()` each time.
- **Run and capture.** `feature=herdr-watch-pane-not-found; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-watch-pane-not-found.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **Shows.** Four lines, each `refresh settled` well under 3000 ms with the logged `pane_not_found` rejection.
  Before the fix the `null` and `omitted` lines are timeouts.

## Gotchas

- `fake.rejectWatch` answers every later watch of that pane, so a kit that retried a rejected watch would
  loop; the kit does not, and the refresh must settle on the first rejection.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
