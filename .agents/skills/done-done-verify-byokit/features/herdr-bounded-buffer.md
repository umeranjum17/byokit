# Herdr bounded bootstrap buffer and settling readiness

Herdr refuses a status watch with its own per-subscription probe id (`<id>:sub:0:probe`), not with
the request id. The kit counts every id derived from the request as that request's refusal, so the
watch's readiness settles and `refresh()` finishes instead of waiting for an acknowledgement that
never comes. A subscription that is stopped, and one Herdr never acknowledges at all, settle their
readiness too (`ackTimeoutMs`, default 15 s). The events a bootstrap holds for its replay are bounded
(512 events, 2 MiB): past the cap the kit reports the overflow through `onLog` and re-reads the tree
from Herdr, so a parked bootstrap cannot grow the kit's memory without limit.

## Sub-features

- `probe-id`: a watch refused with `<id>:sub:0:probe` settles its readiness (`false`), the refusal
  reaches the subscriber and the kit's log, and `refresh()` finishes (before the fix: it never settles).
- `stopped-subscription`: a subscription the caller stops before any acknowledgement settles its
  readiness (`false`) (before the fix: it waits forever).
- `bounded-buffer`: with a status watch that is never acknowledged and events arriving all the time,
  the kit holds at most the cap, reports the overflow, finishes the refresh and re-reads the tree
  (before the fix: the backlog grows without limit and the refresh never finishes).

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, ackTimeoutMs: 500, onLog })`,
  `await kit.start()`, then `fake.rejectWatch(<agent pane id>, 'probe')` and `await kit.refresh()`
  (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in serves a
real Unix socket under the scratch directory and answers `pane_not_found` over it.

- **Write the consumer.** `"$scratch_dir/verify-herdr-bounded-buffer.mjs"` importing `HerdrKit` from
  `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`.
  1. *Probe id*: start a fake (own scratch `dir`) and a kit with an `onLog` that collects lines,
     `await kit.start()`, find the pane whose `agent` is set in `kit.snapshot()`,
     `fake.rejectWatch(paneId, 'probe')`, then race `kit.refresh()` against a 3 s timer. Print
     `probe: refresh settled in <ms> ms, log: <the pane_not_found line>`.
  2. *Stopped subscription*: `fake.holdAck()`, `const stop = kit.subscribe([{ type: 'pane.created' }], () => {})`,
     `stop()`, then `await stop.ready` (a 3 s race). Print `stopped: ready settled in <ms> ms: <value>`.
  3. *Bounded buffer*: a kit with `ackTimeoutMs: 500`; `await kit.start()`, `fake.holdAck()`,
     `const refresh = kit.refresh()`, then emit 800 `pane.updated` events while the bootstrap is parked.
     Print `buffer: <the kit's overflow log line>` and `buffer: refresh settled in <ms> ms`, and the
     fake's `snapshotCount()` before and after (the tree is re-read).
  Exit non-zero if the refresh or the readiness does not settle, if no overflow line is logged, or if
  the tree is not re-read; `await kit.stop()` and `await fake.stop()` each time.
- **Run and capture.** `feature=herdr-bounded-buffer; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-bounded-buffer.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **Shows.** `probe: refresh settled in <ms> ms` with the `pane_not_found` line, `stopped: ready
  settled ... false`, and `buffer:` with the overflow line (the events and bytes the kit held, at most
  the cap) plus a settled refresh and a re-read tree. Before the fix the probe and stopped lines are
  timeouts and the buffer line never appears.

## Gotchas

- `fake.rejectWatch` answers every later watch of that pane, so a kit that retried a refused watch would
  loop; the kit does not, and the refresh must settle on the first refusal.
- `fake.holdAck()` holds the acknowledgement of every later subscription; the kit's `ackTimeoutMs` is what
  ends the wait, so the consumer sets it small (the default is 15 s).
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
