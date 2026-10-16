# Herdr awaited refresh: a tree that already carries your own mutations

An app that drives Herdr and then re-reads it (muxr awaits a fresh tree at ~25 sites after its own
mutations) calls `kit.refresh()`: the kit re-bootstraps the tree and opens the per-pane status
watches, and the promise resolves only once that fresh snapshot has landed. The same re-bootstrap
safety net means a pane/tab/workspace created, closed, moved or renamed while a bootstrap is in
flight lands from the queued follow-up snapshot instead of being dropped, and a `pane.updated` that
introduces an agent onto a pane the last bootstrap saw as a plain shell gets that pane's own status
watch so its status changes reach the tree.

## Sub-features

- `refresh-tab`: after `tab.create`, `await kit.refresh()` resolves with a tree that already carries the new tab.
- `queued-bootstrap`: a pane created while a bootstrap is parked in flight is absent from that bootstrap's tree and present after the queued follow-up, with no later structural event.
- `agent-watch`: a `pane.updated` that names an agent on a previously plain shell opens the pane's `pane.agent_status_changed` watch, and the agent's next status reaches the tree; a title-only update opens nothing.

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`,
  then `await kit.refresh()` and read `kit.snapshot()` (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the kit's stand-in
Herdr serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-refresh.mjs"` importing `HerdrKit` from
  `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and the kit, then
  for each leg asserts the outcome and prints a one-line result:
  - `refresh-tab`: record `kit.snapshot().workspaces[0].tabs.length`, `await kit.call('tab.create', { workspace_id: 'w1', label: 'second' })`,
    `await kit.refresh()`, then assert the snapshot has one more tab and a tab labelled `second`.
  - `queued-bootstrap`: `const release = fake.holdAck();`, `fake.emit({ type: 'tab.renamed', tab_id: 'w1:t1', workspace_id: 'w1', label: 'main2' })`,
    wait until `fake.snapshotCount() >= 2`, `const made = await kit.call('pane.split', { target_pane_id: 'w1:p1' })`
    and capture `made.pane.pane_id`; assert the snapshot does **not** yet hold it, `release()`, then wait
    until the snapshot holds it; assert `fake.snapshotCount() >= 3`.
  - `agent-watch`: assert `fake.watching('w1:p1') === false`; `fake.emit({ type: 'pane.updated', pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', label: 'zsh', terminal_title_stripped: 'zsh · title', focused: false, revision: 1, terminal_id: 'term-w1:p1' } })`,
    wait ~80 ms and assert no watch opened; `fake.emit({ type: 'pane.updated', pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', label: 'pi', agent: 'pi', agent_status: 'idle', focused: false, revision: 2, terminal_id: 'term-w1:p1' } })`,
    wait until `fake.watching('w1:p1') === true`; `fake.emit({ type: 'pane_agent_status_changed', pane_id: 'w1:p1', agent_status: 'working', revision: 9 })`
    and wait until the snapshot pane's `agent.status === 'working'`.
  It exits non-zero on any mismatch, then `await kit.stop()` and `await fake.stop()`.
- **Run and capture.** `feature=herdr-refresh; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-refresh.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **refresh-tab shows.** The refreshed tree lists the new tab by label.
- **queued-bootstrap shows.** The pane is missing from the parked tree, then present after the follow-up (`session.snapshot` calls 1 → 3).
- **agent-watch shows.** The watch list gains `w1:p1` only on the agent-bearing update, and `working` lands in the tree.

## Gotchas

- `fake.holdAck()` holds the next subscribe ack(s): the re-bootstrap parks awaiting its per-pane status watch, so the kit stays in the bootstrap window while the pane is split. Release it to let the queued follow-up read a fresh snapshot.
- `fake.snapshotCount()` counts `session.snapshot` calls, so it is the proof that the queued follow-up actually re-read the tree.
- A `pane.updated` merges only on real agent fields: a title tick on a shell names no agent and must not open a watch.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
