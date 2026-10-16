# Herdr tree mirror: the live tree a consumer reads

A consumer reads Herdr's tree from `kit.snapshot()`/`onChange` instead of polling. The mirror keeps
every pane's pane-level agent fields (`agentStatus`, `displayAgent`, `foregroundCwd`) even for a shell
with no agents record, never invents a phantom agent for a plain shell, and stays current on every
shape change: `workspace.updated` merges label, focused, number, tokens and worktree; the focus events
(`pane.focused`, `tab.focused`, `workspace.focused`) move pane and workspace focus; a partial worktree
(`checkout_path` alone) is kept; agent records carry their `cwd`; a `failed` agent status lands and is
not promptable; every snapshot carries a `revision` that increases on each tree change; and a moved
pane drops its old id while its successor keeps tracking live status pushes.

## Sub-features

- `agentless-pane-fields`: a shell (`w1:p1`) with no agents record keeps `pane.agentStatus`, `pane.displayAgent` and `pane.foregroundCwd` in the tree, and its `pane.agent` stays undefined.
- `no-phantom-agent`: a `pane.updated` title tick on that shell lands the new title but leaves `pane.agent` undefined and opens no status watch (`fake.watching('w1:p1')` stays false).
- `workspace-updated`: tokens via `workspace.report_metadata` and a `workspace_updated` frame with label/focused/worktree land in the tree with no extra `session.snapshot`.
- `focus-events`: `workspace.focus` and `pane.focus` calls flip workspace and pane focus flags in the tree; a `tab_focused` frame changes nothing.
- `partial-worktree`: a worktree record with only `checkout_path` is kept as `{ checkoutPath }`.
- `agent-cwd`: the seeded agent's snapshot record carries `cwd`.
- `failed-status`: a `failed` agent status lands in the tree and `isPromptable` reads false.
- `revision`: the snapshot revision strictly increases across status and title changes.
- `pane-moved`: a `pane_moved` (account-move shape) swaps the pane id in the tree and the successor tracks a later status push.

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`,
  then mirror with `kit.snapshot()`/`kit.onChange()` (packages/herdr/README.md). `w1:p1` is the fake's
  plain shell; `w1:p2` its agent.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the kit's stand-in
Herdr serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the pane-level consumer.** `"$scratch_dir/verify-herdr-tree-mirror.mjs"` importing `HerdrKit` from
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
- **Write the shape consumer.** `"$scratch_dir/verify-herdr-tree-shape.mjs"` importing `HerdrKit` and
  `isPromptable` from `@byokit/herdr`, and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the
  fake and the kit, then for each leg asserts the outcome and prints one line per sub-feature:
  - `workspace-updated`: `await kit.call('workspace.report_metadata', { workspace_id: 'w1', source: 'verify', tokens: { t: '1' } })`,
    then wait for `onChange`/`snapshot()` to carry `workspaces[0].tokens.t === '1'`; then
    `fake.emit({ type: 'workspace.updated', workspace: { workspace_id: 'w1', label: 'renamed', focused: false, tokens: { t: '1' }, worktree: { repo_key: 'k', repo_name: 'n', repo_root: '/r', checkout_path: '/r', is_linked_worktree: true } } })`
    and wait for the label, focused flag and full worktree to land.
  - `focus-events`: `await kit.call('workspace.create', { label: 'two' })`, wait for two workspaces,
    `await kit.call('workspace.focus', { workspace_id: 'w2' })` and wait for `w2.focused` true and
    `w1.focused` false with exactly one focused pane in `w2`; then
    `await kit.call('pane.focus', { pane_id: 'w1:p1' })` and wait for the flags to move back; then
    `fake.emit({ type: 'tab.focused', tab_id: 'w1:t1', workspace_id: 'w1' })` and check the tree is unchanged.
  - `partial-worktree`: `fake.emit({ type: 'workspace.updated', workspace: { workspace_id: 'w1', worktree: { checkout_path: '/srv/only-checkout' } } })`,
    then the snapshot's `worktree` carries `checkoutPath` and none of the optional fields.
  - `agent-cwd`: `kit.snapshot()` agent on `w1:p2` carries `cwd` equal to the fake world's cwd.
  - `failed-status`: `fake.setStatus('w1:p2', 'failed')`, wait for the tree to carry `failed`, and
    `isPromptable(agent)` is false.
  - `revision`: read the revision, drive `fake.setStatus('w1:p2', 'working')`, wait for the tree,
    read again — strictly greater; drive a second change, strictly greater again.
  - `pane-moved`: move `w1:p2` to a fresh id (`fake.world` mutation swapping the pane/agent ids to
    `w1:p9` plus `fake.emit({ type: 'pane.moved', previous_pane_id: 'w1:p2', pane: { pane_id: 'w1:p9', ... }, previous_tab_id: 'w1:t1', previous_workspace_id: 'w1' })`),
    wait for `w1:p9` in the tree with `w1:p2` gone, then `fake.setStatus('w1:p9', 'working')` and wait for
    the successor's status to land.
  It exits non-zero on any mismatch, then `await kit.stop()` and `await fake.stop()`.
- **Run and capture.** `feature=herdr-tree-mirror; entry=@byokit/herdr;
  drive=(node "$scratch_dir/verify-herdr-tree-mirror.mjs")` and
  `drive=(node "$scratch_dir/verify-herdr-tree-shape.mjs")`;
  then run SKILL.md Evidence's capture block for each. Exit code `0`, one printed line per sub-feature.
- **agentless-pane-fields shows.** The shell pane's `agentStatus`/`displayAgent`/`foregroundCwd` and `agent === undefined`.
- **no-phantom-agent shows.** The renamed title, `agent === undefined` and `watching('w1:p1') === false` after the held bootstrap.
- **workspace-updated shows.** Label/focused/tokens/worktree merged with the snapshot answer held.
- **focus-events shows.** Workspace and pane focus flags move with the focus calls; `tab_focused` changes nothing.
- **partial-worktree shows.** `{ checkoutPath }` alone, no optional fields conjured.
- **agent-cwd shows.** The agent record's `cwd` equals the fake world's cwd.
- **failed-status shows.** `failed` in the tree, `isPromptable` false.
- **revision shows.** Strictly increasing across a status push and a title merge.
- **pane-moved shows.** The old id is gone and the successor tracks `fake.setStatus` on the new id.

## Gotchas

- Seed the shell's Herdr-level fields by mutating `fake.world` before `kit.start()`: the snapshot is read
  from that live world, so no event has to carry them. `display_agent` also rides the fake's `pane.get`/snapshot views.
- `pane.updated` arriving while a bootstrap is in flight is buffered and replayed through the tree update
  right before the status watches open, so `holdSnapshot()`/`release()` is the way to make the phantom-agent
  leg deterministic.
- `workspace.updated` does not trigger a re-bootstrap (it is not a structural event); a held
  `session.snapshot` count is the way to prove the merge is in place.
- Focus calls emit the wire frames themselves (`workspace_focused`, `pane_focused`); do not emit them by hand
  around focus calls or the tree sees each change twice.
- `pane.moved` swaps pane ids: the status watch for the old id dies with the re-bootstrap, so assert the
  successor with `fake.setStatus` on the new id only.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
