# Herdr turn start: accept `done`, and `files: false` skips the scan

A consumer app runs an agent turn with `kit.runTurn`. An agent that is already `done` (finished its
last turn) is a valid starting state, exactly like `idle`, so the turn is not refused with
`turn-not-idle`/`turn-busy`. And a turn rooted in a folder too large to walk (for example a checkout
with a `node_modules` over 10,000 entries) can pass `files: false` to skip the file scan entirely:
the turn then reports no changed files instead of failing with `turn: file limit`.

## Sub-features

- `done-at-start`: an agent whose status is already `done` starts the turn (the old code only accepted `idle`).
- `files-false`: `files: false` skips both scans, so a directory with more than 10,000 entries neither fails nor is walked (`changedFiles` is `[]`).
- `scan-limit-intact`: with the default policy (no `files: false`) the same large tree still rejects the turn with code `turn-failed`.

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`,
  `await kit.statusWatchReady()`, then `kit.runTurn({ paneId: 'w1:p2', name: 'pi' }, { prompt, cwd, files })`
  (packages/herdr/README.md).
- `fake.setStatus('w1:p2', 'done')` puts the agent in the finished state before the turn.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the kit's stand-in
Herdr serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-turn.mjs"` importing `HerdrKit` from `@byokit/herdr`
  and `startFakeHerdr` from `@byokit/herdr/testing`. For each journey, start the fake and the kit, read the
  agent's `cwd` from `fake.world`, run the turn and print the outcome:
  - `done-at-start`: `fake.setStatus('w1:p2', 'done')`, then `await kit.runTurn({ paneId: 'w1:p2', name: 'pi' }, { prompt: 'finish', cwd, timeoutMs: 5000 })` resolves with `status: 'done'` and never `turn-not-idle`.
  - `files-false`: create 10,001 files under `cwd/node_modules`, then `await kit.runTurn(target, { prompt: 'finish', cwd, files: false, timeoutMs: 5000 })` resolves with `status: 'done'` and `changedFiles: []`.
  - `scan-limit-intact`: on that same large tree, `await kit.runTurn(target, { prompt: 'default scan', cwd, timeoutMs: 60000 })` rejects with code `turn-failed`.
  It exits non-zero on any mismatch, then `await kit.stop()` and `await fake.stop()`.
- **Run and capture.** `feature=herdr-turn-accept-done-files-false; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-turn.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **done-at-start shows.** The turn resolves `status: 'done'` instead of switching to `idle`.
- **files-false shows.** The turn over the >10,000-entry tree resolves with no changed files.
- **scan-limit-intact shows.** The same tree without `files: false` rejects `turn-failed`.

## Gotchas

- The stand-in agent settles `idle` 50 ms after a prompt. To end a turn on `done`, set the status again
  inside that window (the feature consumer beats `done` every 15 ms and clears it when the turn resolves).
- `files: false` reads no file limits, so an invalid `maxFiles`/`maxBytes` alongside it is not checked —
  that is intentional, there is no scan to bound.
- The turn's `cwd` must equal the agent's reported working directory (the fake's `<dir>/project`).
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
