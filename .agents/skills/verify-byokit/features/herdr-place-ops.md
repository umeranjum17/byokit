# Herdr placement: the placed event and the agentless place op

A host app learns where a start landed before the launch settles, and can open shells without
starting anything: `kit.startAgent` emits `placed` (`{ paneId, tabId, workspaceId }`) between
`installing` and `ready`, and `kit.place({ cwd?, place, env? })` resolves the same ladder —
shell/application tab, shell split, new or labelled workspace — with no agent at all.

## Sub-features

- `placed-before-ready`: a `startAgent` emits `placed` with the placed pane/tab/workspace ids before `ready`; the ids name the pane's own tab and workspace in the Herdr tree.
- `placed-panes-refusal`: a placement that never resolves (unknown workspace) emits `launchFailed` with reason `placement-failed` and no `placed`; a start whose launch fails after a resolved placement emits `placed` then `launchFailed`.
- `place-tab`: `kit.place({ place: { tab: 'new', workspaceId } })` opens a shell tab (or an application tab carrying its own `env`) and starts no agent; the ref names the fresh pane, its tab and workspace.
- `place-split`: `kit.place({ place: { split, direction } })` splits a shell pane and starts no agent.
- `place-label`: a labelled workspace is reused (tab lands in the existing workspace), created when missing, and two matches refuse with `workspace-ambiguous` creating nothing.
- `place-pane`: `kit.place({ place: { pane } })` names an existing pane, answers its ids from `pane.get`, creates nothing, and refuses an `env` there.

## How to get to it (user POV)

- Adopt the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`
  (packages/herdr/README.md).
- Host side: `kit.onStartAgent((e) => ...)` plus `kit.startAgent(...)`, and `kit.place(...)` for the
  agentless placements.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in Herdr
serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-place-ops.mjs"` importing `HerdrKit`
  from `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and kit, then asserts each leg:
  - `placed-before-ready`: collect `kit.onStartAgent` events around
    `kit.startAgent({ kind: 'pi', cwd, place: { tab: 'new', workspaceId: 'w1' } })`; the phases are exactly
    `['placed', 'ready']`, the `placed` ref carries `{ paneId: <returned ref>, tabId, workspaceId: 'w1' }`, and
    the pane's `tab_id` in `kit.call('pane.get', ...)` equals the placed `tabId`.
  - `placed-panes-refusal`: `place: { tab: 'new', workspaceId: 'missing' }` rejects with `workspace_not_found`,
    and the events are exactly `['launchFailed']` (reason `placement-failed`); with one
    `fake.agentStartFaults.push({ code: 'agent_failed', message: 'boom' })`, `place: { pane: 'w1:p1' }` rejects
    with `boom` and the events are exactly `['placed', 'launchFailed']`.
  - `place-tab`: `kit.place({ cwd, place: { tab: 'new', workspaceId: 'w1', label: 'shells' } })` resolves
    `{ paneId, tabId, workspaceId: 'w1' }`, the tab label reads `shells`, and no agent exists on the pane;
    `kit.place({ cwd: '/opt/app', env: { APP_ENV: 'yes' }, place: { tab: 'new', workspaceId: 'w1' } })` carries
    the env on the fresh pane (`pane.get`), still with no agent.
  - `place-split`: `kit.place({ place: { split: 'w1:p1', direction: 'down' } })` resolves a ref whose pane is in
    `w1:t1`, with no agent on it and exactly one new pane in the fake's world.
  - `place-label`: `kit.place({ place: { workspace: 'fresh-label' } })` creates a workspace with that label
    (ref points inside it, no agent); a second call reuses it (workspace count unchanged); after a second
    `workspace.create` with the same label, a third rejects with `code: 'workspace-ambiguous'`.
  - `place-pane`: `kit.place({ place: { pane: 'w1:p1' } })` resolves exactly
    `{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1' }` with no pane created; `kit.place({ env: { A: 'b' },
    place: { pane: 'w1:p1' } })` rejects with `code: 'env_mismatch'`.
  It exits non-zero on any mismatch, then closes the kit and fake.
- **Run and capture.** `feature=herdr-place-ops; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-place-ops.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **placed-before-ready shows.** Phases `['placed', 'ready']` and the placed tab id matching the pane's own.
- **placed-panes-refusal shows.** `['launchFailed']` alone on the refused placement, `['placed', 'launchFailed']` on the failed launch.
- **place-tab / place-split show.** Fresh tab and split panes in the fake with the right labels/env and no agents.
- **place-label / place-pane show.** Reuse-then-ambiguous label behaviour, and the pane place creating nothing.

## Gotchas

- The fake seeds w1 (`w1:t1`, `w1:p1` shell + `w1:p2` agent of the first kind) with label `<scratch>/project`;
  a label leg must use fresh labels, or `fake.world.workspaces[0].label` to reuse w1 itself.
- Placement results land in the kit snapshot through a re-bootstrap, so wait for the pane to appear in
  `kit.snapshot()` before asserting tree counts; the fake's live `fake.world` is immediate.
- Adopt mode never stops the stand-in server, so `await kit.stop()` and `await fake.stop()`.
