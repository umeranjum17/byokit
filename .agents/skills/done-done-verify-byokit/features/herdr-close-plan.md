# Herdr close plan: the close sentence's topology from one live read

A host app that asks "close this pane?" needs where the pane sits — its tab, its workspace's label, and the
worktree group closing that workspace would take with it — and must still see a retryable failure when Herdr
is not answering. `kit.closePlan(paneId)` answers `{ paneId, tabId, workspaceId, workspaceLabel, group? }`
from live reads (`pane.get`, `workspace.get`, `workspace.list`), never from the kit's in-memory tree.

## Sub-features

- `plan-root`: on a worktree-group root's pane, `group` is `{ label: <repo name>, size: <member count> }`, the
  same naming a `workspace-close-would-widen` refusal carries.
- `plan-member`: on a linked checkout's pane, `group` is absent (that workspace closes alone).
- `plan-gone`: a pane that has gone rejects with code `pane-unavailable`.
- `plan-down`: with Herdr stopped, `kit.snapshot()` still answers but `closePlan` rejects with the socket
  read's own failure (`herdr: socket closed`, no `pane-unavailable` code).

## How to get to it (user POV)

- Adopt the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`
  (packages/herdr/README.md).
- Host side: `await kit.closePlan(paneId)` before showing the close sentence.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in Herdr
serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-close-plan.mjs"` importing `HerdrKit` from `@byokit/herdr`
  and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and kit, then asserts each leg:
  - `plan-root`: `kit.rename({ workspace: 'w1', label: 'Umer' })`, then `kit.startAgent({ kind: 'pi',
    cwd: '/tmp/verify-close-plan', place: { workspace: 'new' }, worktree: { branch: 'verify' } })` links a
    checkout into w1's group; `kit.closePlan('w1:p1')` deep-equals `{ paneId: 'w1:p1', tabId: 'w1:t1',
    workspaceId: 'w1', workspaceLabel: 'Umer', group: { label: 'fake-herdr', size: 2 } }`.
  - `plan-member`: `kit.closePlan(<started agent's paneId>)` has no `group`.
  - `plan-gone`: `kit.closePlan('w9:p9')` rejects with code `pane-unavailable`.
  - `plan-down`: `await fake.stop()`; `kit.snapshot()` still lists w1; `kit.closePlan('w1:p1')` rejects with
    message `herdr: socket closed` and no `code`.
  It prints each result, exits non-zero on any mismatch, then stops the kit.
- **Run and capture.** `feature=herdr-close-plan; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-close-plan.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **plan-root shows.** The plan with `group: { label: 'fake-herdr', size: 2 }`.
- **plan-member shows.** The plan without `group`.
- **plan-gone shows.** `pane-unavailable`.
- **plan-down shows.** `herdr: socket closed` while the in-memory tree still answers.

## Gotchas

- The fake labels w1 with its project path; rename it first so the evidence shows a plain label.
- The group needs `worktree.create` (through `kit.startAgent({ worktree })`); only then does w1 share a
  `repo_key` with a linked checkout.
- Stop the fake before the kit for `plan-down`; adopt mode never stops the stand-in itself.
