# Herdr awaited refresh: a tree that already carries your own mutations

An app that drives Herdr and then re-reads it (muxr awaits a fresh tree at ~25 sites after its own
mutations) calls `kit.refresh()`: the kit re-bootstraps the tree and opens the per-pane status
watches, and the promise resolves only once that fresh snapshot has landed. The same re-bootstrap
safety net means a pane/tab/workspace created, closed, moved or renamed while a bootstrap is in
flight lands from the queued follow-up snapshot instead of being dropped, and a `pane.updated` that
introduces an agent onto a pane the last bootstrap saw as a plain shell gets that pane's own status
watch so its status changes reach the tree. `onState` hears only a change of phase (or `why`), so a
re-read that lands on an already `ready` kit stays silent and a host re-reading on `ready` cannot loop.

## Sub-features

- `refresh-tab`: after `tab.create`, `await kit.refresh()` resolves with a tree that already carries the new tab.
- `queued-bootstrap`: a pane created while a bootstrap is parked in flight is absent from that bootstrap's tree and present after the queued follow-up, with no later structural event.
- `agent-watch`: a `pane.updated` that names an agent on a previously plain shell opens the pane's `pane.agent_status_changed` watch, and the agent's next status reaches the tree; a title-only update opens nothing.
- `ready-on-change`: five `refresh()` calls record `onState` phases `connecting, ready` only; stopping the fake and starting a new one on the same `dir` adds `reconnecting, ready`; a kit whose `onState` calls `refresh()` on every `ready` reads the snapshot at most twice in 2 s.
- `refresh-join`: a `refresh()` asked for after a change while an earlier refresh is parked past its read resolves with a tree that carries the change; a second late caller shares that one follow-up read; with the next snapshot failing, of two concurrent calls the first rejects with its code and the second is answered by the follow-up.

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
  - `ready-on-change`: a second kit and fake on their own scratch `dir` with `onState: (s) => states.push(s.phase)`;
    `await kit.start()`, five `await kit.refresh()`, assert `states` is `['connecting', 'ready']`; `await fake.stop()`,
    `startFakeHerdr({ dir })` again, wait until four states and assert `['connecting', 'ready', 'reconnecting', 'ready']`.
    Then a third kit with `onState: (s) => { if (s.phase === 'ready') kit.refresh().catch(() => {}); }`, start it,
    wait 2 s and assert `fake.snapshotCount() <= 2` (before the fix it climbs into the thousands).
  - `refresh-join`: on a fresh kit and fake, `fake.snapshotCount()` is 1 after start; `const release = fake.holdAck();`,
    `const first = kit.refresh()`, wait until the count is 2 (the first refresh has read and parks);
    `fake.world.tabs[0].label = 'renamed'` (a change with no event of its own), `const second = kit.refresh()`,
    `const third = kit.refresh()`, `release()`, `await first; await second;` and assert the first tab is labelled
    `renamed` (before the fix `second` joined `first` and answered with `main`); `await third` and assert
    the count is 3; `fake.failNextSnapshot('snapshot_failed', 'the snapshot read failed')`, then
    `Promise.allSettled([kit.refresh(), kit.refresh()])` and assert `['rejected', 'fulfilled']`.
  It exits non-zero on any mismatch, then `await kit.stop()` and `await fake.stop()`.
- **Run and capture.** `feature=herdr-refresh; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-refresh.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **refresh-tab shows.** The refreshed tree lists the new tab by label.
- **queued-bootstrap shows.** The pane is missing from the parked tree, then present after the follow-up (`session.snapshot` calls 1 → 3).
- **agent-watch shows.** The watch list gains `w1:p1` only on the agent-bearing update, and `working` lands in the tree.
- **ready-on-change shows.** The recorded phases after five refreshes and one reconnect, and the snapshot count of the re-read-on-ready kit (1 or 2).
- **refresh-join shows.** The late refresh's tree carries `renamed`, the two late callers cost one follow-up read (count 1 → 3), and the failed pair settles `rejected, fulfilled`.

## Gotchas

- `fake.holdAck()` holds the next subscribe ack(s): the re-bootstrap parks awaiting its per-pane status watch, so the kit stays in the bootstrap window while the pane is split. Release it to let the queued follow-up read a fresh snapshot.
- `fake.snapshotCount()` counts `session.snapshot` calls, so it is the proof that the queued follow-up actually re-read the tree.
- A `pane.updated` merges only on real agent fields: a title tick on a shell names no agent and must not open a watch.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
