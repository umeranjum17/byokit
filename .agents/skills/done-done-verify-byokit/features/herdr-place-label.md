# Herdr label placement: startAgent lands in the workspace with that label

A host app calls `kit.startAgent({ ..., place: { workspace: '<label>', label: 'byokit' } })` and gets
`{ paneId, name, created }`: the agent lands in the existing workspace with that label (new tab,
`created: false`) or in a new workspace (`created: true`), so apps stop making duplicate workspaces.

## Sub-features

- `reuse`: one workspace labelled `byokit` gets a new tab with the agent; `created` is `false` and the workspace count is unchanged.
- `create`: no workspace with the label exists; the start creates it with that label and `created` is `true`.
- `create-tab-label`: the create leg passes `label: 'task-title'` too; the new workspace's root tab carries `task-title` while the workspace keeps the workspace label.
- `failed-keeps-workspace`: a failing `agent.start` into a reused workspace rolls back only the fresh pane; the workspace still exists afterwards.
- `ambiguous`: two workspaces share one label; the start refuses with the named `workspace-ambiguous` error and creates nothing.

## How to get to it (user POV)

- Adopt the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`
  (packages/herdr/README.md).
- Host side: `kit.startAgent({ kind: 'codex', cwd, place: { workspace: '<label>', label? } })`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in Herdr
serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-place-label.mjs"` importing `HerdrKit`
  from `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and kit, then asserts each leg:
  - `reuse`: `kit.call('workspace.create', { cwd: '/tmp/verify-place', label: 'byokit' })` returns workspace `w2`;
    `kit.startAgent({ kind: 'codex', cwd: '/tmp/verify-place', place: { workspace: 'byokit', label: 'agent' } })`
    resolves `{ paneId, name, created: false }` with the pane inside `w2`, and the workspace count is unchanged.
  - `create`: `kit.startAgent({ kind: 'codex', cwd: '/tmp/verify-place', place: { workspace: 'fresh-label' } })`
    resolves `{ paneId, name, created: true }` with the pane inside a new workspace labelled `fresh-label`.
  - `create-tab-label`: `kit.startAgent({ kind: 'codex', cwd: '/tmp/verify-place', place: { workspace: 'fresh-tab-ws', label: 'task-title' } })`
    resolves `created: true`; the new workspace is labelled `fresh-tab-ws` and its root tab (the pane's tab in
    `kit.snapshot()`, waited for) is labelled `task-title`.
  - `failed-keeps-workspace`: with one `agent.start` fault queued (`fake.agentStartFaults.push({ code: 'agent_failed', message: 'boom' })`),
    `kit.startAgent({ kind: 'codex', cwd: '/tmp/verify-place', place: { workspace: 'byokit' } })` rejects with `boom`,
    the `byokit` workspace still exists, and the pane count is back to before.
  - `ambiguous`: after a second `workspace.create` with label `byokit-dup` alongside a first,
    `kit.startAgent({ kind: 'codex', cwd: '/tmp/verify-place', place: { workspace: 'byokit-dup' } })` rejects with
    `code: 'workspace-ambiguous'`, and workspace and pane counts are unchanged.
  It exits non-zero on any mismatch, then closes the kit and fake.
- **Run and capture.** `feature=herdr-place-label; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-place-label.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **reuse shows.** `{ paneId: <fresh pane in w2>, name: 'codex', created: false }`, workspace count unchanged.
- **create shows.** `{ paneId: <fresh pane>, name: 'codex', created: true }`, one new workspace labelled `fresh-label`.
- **create-tab-label shows.** The `fresh-tab-ws` workspace with its root tab labelled `task-title`.
- **failed-keeps-workspace shows.** Rejection `herdr: agent_failed: boom`, the `byokit` workspace present, pane count restored.
- **ambiguous shows.** Rejection `code: 'workspace-ambiguous'`, workspace and pane counts unchanged.

## Gotchas

- The fake seeds w1 with label `<scratch>/project`, so a test label never collides with it; use fresh labels per leg.
- `workspace.create`/`tab.create` land in the kit snapshot through a re-bootstrap, so wait for the pane or
  workspace to appear in `kit.snapshot()` before asserting counts.
- Adopt mode never stops the stand-in server, so `await kit.stop()` and `await fake.stop()`.
