# Herdr tree mirror: agentless panes keep their fields, and a shell never gets a phantom agent

A consumer reads Herdr's tree from `kit.snapshot()`/`onChange`. Every pane carries the pane-level agent
fields Herdr reports on every pane — `agentStatus`, `displayAgent` and `foregroundCwd` — even a shell
with no agents record, so an app can read a shell's status, name and cwd. A `pane.updated` title tick on
a plain shell merges its title but does not invent a `pane.agent`, and the shell opens no per-pane status
watch.

## Sub-features

- `agentless-pane-fields`: a shell (`w1:p1`) with no agents record keeps `pane.agentStatus`, `pane.displayAgent` and `pane.foregroundCwd` in the tree, and its `pane.agent` stays undefined.
- `no-phantom-agent`: a `pane.updated` title tick on that shell lands the new title but leaves `pane.agent` undefined and opens no status watch (`fake.watching('w1:p1')` stays false).

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`, and
  reads `kit.snapshot()` (packages/herdr/README.md, "API at a glance"). `w1:p1` is the fake's plain shell.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the kit's stand-in
Herdr serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-tree-mirror.mjs"` importing `HerdrKit` from
  `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake, seeds the shell
  pane's Herdr-level fields directly on the live world, starts the kit, then asserts and prints each leg:
  - `agentless-pane-fields`: `fake.world.panes.find((p) => p.pane_id === 'w1:p1')` gets `agent_status = 'unknown'`
    and `display_agent = 'zsh'` before `kit.start()`. After `await kit.statusWatchReady()`, find the pane in
    `kit.snapshot()` and assert `pane.agent === undefined`, `pane.agentStatus === 'unknown'`,
    `pane.displayAgent === 'zsh'` and `pane.foregroundCwd === fake.world.cwd`, and `fake.watching('w1:p1') === false`.
  - `no-phantom-agent`: `const release = fake.holdSnapshot()`, then
    `fake.emit({ type: 'pane.created', pane: { pane_id: 'w1:p9', tab_id: 'w1:t1', workspace_id: 'w1' } })` to
    start a held bootstrap; wait until `fake.snapshotCount() >= 2`, emit a `pane.updated` for `w1:p1` with
    `terminal_title_stripped: 'zsh · renamed'` and `agent_status: 'unknown'`, then `release()` and
    `await kit.statusWatchReady()`. Assert the pane's `terminalTitle === 'zsh · renamed'`, its `agent` is still
    undefined, and `fake.watching('w1:p1') === false`.
  It exits non-zero on any mismatch, then `await kit.stop()` and `await fake.stop()`.
- **Run and capture.** `feature=herdr-tree-mirror; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-tree-mirror.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **agentless-pane-fields shows.** The shell pane's `agentStatus`/`displayAgent`/`foregroundCwd` and `agent === undefined`.
- **no-phantom-agent shows.** The renamed title, `agent === undefined` and `watching('w1:p1') === false` after the held bootstrap.

## Gotchas

- Seed the shell's Herdr-level fields by mutating `fake.world` before `kit.start()`: the snapshot is read
  from that live world, so no event has to carry them. `display_agent` also rides the fake's `pane.get`/snapshot views.
- `pane.updated` arriving while a bootstrap is in flight is buffered and replayed through the tree update
  right before the status watches open, so `holdSnapshot()`/`release()` is the way to make the phantom-agent
  leg deterministic.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
