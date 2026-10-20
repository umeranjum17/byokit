# Herdr changed panes: onChange names the agent whose status moved

A host mirrors Herdr's agent states from `kit.onChange`. Every tree revision used to look alike, so the
host re-emitted every agent state after a debounce. `onChange(snapshot, changed)` now also passes the pane
ids whose agent status differs from the last published tree: a status push names its pane, and a
title-only revision names none, so the host emits just the one state at once.

## Sub-features

- `changed-panes`: an agent's status push reaches `onChange` with `changed` = that pane id alone; a title tick on the same pane arrives with `changed` = `[]`.

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`,
  then `kit.onChange((snapshot, changed) => ...)` (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress.

- **Write the consumer.** `"$scratch_dir/verify-herdr-changed-panes.mjs"` importing `HerdrKit` from `@byokit/herdr`
  and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and the kit, records every
  `onChange` call as `[snapshot, changed]`, then:
  - `fake.emit({ type: 'pane.updated', pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', label: 'pi', agent: 'pi', agent_status: 'idle', focused: false, revision: 2, terminal_id: 'term-w1:p1' } })`,
    wait until `fake.watching('w1:p1') === true` and `await kit.statusWatchReady()`.
  - Mark the recorded count, `fake.emit` a title tick on `w1:p1` (`pane.updated` with `terminal_title_stripped: 'pi · working'`),
    wait for one new call and assert its `changed` is `[]`.
  - `fake.emit({ type: 'pane_agent_status_changed', pane_id: 'w1:p1', agent_status: 'working', revision: 9 })`,
    wait for a call whose `changed` is `['w1:p1']`, and assert the snapshot pane's `agent.status === 'working'`.
  It exits non-zero on any mismatch, then `await kit.stop()` and `await fake.stop()`.
- **Run and capture.** `feature=herdr-changed-panes; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-changed-panes.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **changed-panes shows.** The status push's `changed` is `['w1:p1']`, and the title tick's is `[]`.

## Gotchas

- Before the change `onChange` took one argument, so `changed` is `undefined` and the drive fails: that is the proof the detail is new.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
