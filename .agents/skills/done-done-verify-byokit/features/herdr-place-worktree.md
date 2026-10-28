# Herdr placement in a new worktree: the agentless place op makes the checkout

A host app opens a shell in a new linked checkout with one call: `kit.place({ cwd, worktree: { branch? },
place })` runs `worktree.create` first and answers the shell's pane, tab and workspace ids. A failed
`worktree.create` leaves no tab, workspace or pane behind.

## Sub-features

- `place-worktree`: `kit.place({ cwd, worktree: { branch }, place: { tab: 'new', workspaceId } })` creates a
  linked checkout whose workspace is new; the shell pane's cwd is the checkout path and no agent runs there.
- `place-worktree-fault`: with `worktree.create` failing, `kit.place` rejects with the real code and the fake's
  workspace, tab and pane counts are unchanged (integration test only; see the drive notes).

## How to get to it (user POV)

- Adopt the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`
  (packages/herdr/README.md).
- Host side: `kit.place({ cwd, worktree: { branch: 'umer/try' }, place: { tab: 'new', workspaceId } })`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in Herdr
serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-place-worktree.mjs"` importing `HerdrKit` from
  `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`.
  It asserts the `place-worktree` leg, then closes the kit and fake:
  - `place-worktree`: `kit.place({ cwd: '/tmp/verify-worktree/umer-try', worktree: { branch: 'umer/try' },
    place: { tab: 'new', workspaceId: 'w1' } })` resolves a ref whose pane (`fake.world.panes`) has
    `cwd === '/tmp/verify-worktree/umer-try'`, whose workspace has `worktree.checkout_path` equal to that path and
    `is_linked_worktree: true`, and no agent on the pane.
  - `place-worktree-fault` is not driven here: the stand-in has no `worktree.create` fault and the socket transport is
    not public; no maintained test drives it.
- **Run and capture.** `feature=herdr-place-worktree; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-place-worktree.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **place-worktree shows.** The shell's cwd is the checkout path, the placed workspace is the linked checkout.
- **place-worktree-fault.** Covered by the place.test.ts integration test named above; the run output names it.

## Gotchas

- The fake's `worktree.create` uses the given `cwd` as the checkout path and ignores `workspace_id`; the placed
  workspace is always a new one, so assert the checkout, not a particular workspace id.
- Placement results land in the kit snapshot through a re-bootstrap; the fake's `fake.world` is immediate.
- Adopt mode never stops the stand-in server, so `await kit.stop()` and `await fake.stop()`.
