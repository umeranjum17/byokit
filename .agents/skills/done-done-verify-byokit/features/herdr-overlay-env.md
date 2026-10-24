# Herdr overlay env: startAgent verifies set and unset in the pane before starting

A host app calls `kit.startAgent({ ..., env: { overlay: { ... }, unset: [...] } })` and the values land
on the pane's inherited environment — verified in the pane before `agent.start` — while every other
export survives. A mismatch fails closed with `env_mismatch` and the agent never starts.

## Sub-features

- `overlay-keeps-rest`: on a caller-owned pane with pre-existing exports, the overlay values land, the
  unset names are gone, and unrelated exports survive (where the `{ env, unset }` replacement form would
  scrub them).
- `mismatch-no-start`: an invalid overlay (a bad name, or a name in both `overlay` and `unset`) rejects
  with `code: 'env_mismatch'` after the placement resolved (`placed` fired) but no agent started, and a
  created pane rolls back.

## How to get to it (user POV)

- Adopt the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`
  (packages/herdr/README.md).
- Host side: `kit.startAgent({ kind, cwd, place, env: { overlay, unset? } })`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in Herdr
serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-overlay-env.mjs"` importing `HerdrKit`
  from `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and kit,
  then asserts each leg:
  - `overlay-keeps-rest`: seed the `w1:p1` pane env with `{ PATH: '/usr/bin:/bin', KEEP: 'yes', REMOVE: 'yes' }`;
    `kit.startAgent({ kind: 'codex', cwd: '/tmp/verify-overlay', place: { pane: 'w1:p1' },
    env: { overlay: { ADDED: 'one' }, unset: ['REMOVE'] } })` resolves; the pane env gains `ADDED: 'one'`,
    loses `REMOVE`, and keeps `KEEP: 'yes'`.
  - `mismatch-no-start`: `kit.startAgent({ kind: 'codex', cwd: '/tmp/verify-overlay', place: { workspace: 'new' },
    env: { overlay: { 'bad;name': 'x' } }, timeoutMs: 5000 })` rejects with `code: 'env_mismatch'`; the
    `placed` event fired first, no agent record exists on the placed pane, and the pane count is back to
    before (the created pane rolled back).
  It exits non-zero on any mismatch, then closes the kit and fake.
- **Run and capture.** `feature=herdr-overlay-env; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-overlay-env.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **overlay-keeps-rest shows.** Pane env `{ PATH, KEEP: 'yes', ADDED: 'one' }` with no `REMOVE`.
- **mismatch-no-start shows.** Rejection `code: 'env_mismatch'`, `placed` fired, no agent on the placed pane, pane count restored.

## Gotchas

- The overlay form passes nothing to the placement create calls, so a fresh pane starts with no recorded
  env; seed a caller-owned pane's env to prove unrelated exports survive.
- Adopt mode never stops the stand-in server, so `await kit.stop()` and `await fake.stop()`.
