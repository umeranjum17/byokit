# Herdr confirmed-scope close and shell sendKeys

A rollback close of a pane the caller just made needs a non-widening close: `closePane` still refuses
`pane-close-would-widen` (naming the wider target), and echoing that target back —
`closePane(paneId, { confirmed: { scope: 'tab', id } })` — closes exactly that tab. The kit verifies the live
tree still matches (the pane is still the confirmed tab's sole pane, else `confirmed-scope-mismatch`) and the
exact path's own `tab-close-would-widen` guard still applies, so a confirmed close never widens past the
confirmed scope. `sendKeys` reaches plain shells: a pane with no agent (`agent.send_keys` answering
`agent_not_found`) falls back to `pane.send_keys`, so aborts and device keys land on shell routes.

## Sub-features

- `confirm-close`: `kit.closePane(paneId, { confirmed: { scope: 'tab', id } })` on a sole pane closes exactly
  that tab (its panes gone, sibling tabs surviving).
- `confirm-stale`: after the tree changed — the pane split (no longer sole) or moved to another tab — the same
  call throws `confirmed-scope-mismatch` and closes nothing; a gone pane still throws `pane-unavailable`.
- `confirm-ladder`: a confirmed close never widens past the confirmed scope — a sole pane of the workspace's
  only tab throws `tab-close-would-widen` naming that workspace (`{ scope: 'workspace', id }`), and the plain
  exact `closeWorkspace` finishes the rollback.
- `shell-keys`: `kit.sendKeys({ paneId }, keys)` on a shell pane (no agent) lands via `pane.send_keys`; an agent
  pane still rides `agent.send_keys`; a gone pane surfaces `pane_not_found`.

## How to get to it (user POV)

- Adopt the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`
  (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in Herdr
serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-close-confirm-keys.mjs"` importing `HerdrKit` from
  `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and kit, then asserts:
  - `confirm-close`: `kit.call('workspace.create', { cwd: '/tmp/verify-confirm', label: 'Roll' })` gives `w2`
    (sole pane `w2:p1` of sole tab `w2:t1`); `kit.call('tab.create', { workspace_id: 'w2' })` adds `w2:t2`;
    plain `kit.closePane('w2:p1')` rejects `pane-close-would-widen` with `{ scope: 'tab', id: 'w2:t1' }`;
    the confirmed call then removes `w2:t1` and `w2:p1` while `w2:t2` survives (read
    `kit.call('tab.get', …)` rejections and `kit.snapshot()`).
  - `confirm-stale`: split `w2:p2` (`kit.call('pane.split', …)`), then the confirmed close of `w2:p2` naming
    `w2:t2` rejects `confirmed-scope-mismatch` with both panes still present; the same call naming a wrong tab
    id rejects `confirmed-scope-mismatch`; `closePane('w9:p9', { confirmed: … })` rejects `pane-unavailable`.
  - `confirm-ladder`: a fresh `workspace.create` gives `w3` (sole pane, sole tab); the confirmed close of
    `w3:p1` naming `w3:t1` rejects `tab-close-would-widen` with `{ scope: 'workspace', id: 'w3' }`;
    `kit.closeWorkspace('w3')` then succeeds.
  - `shell-keys`: `kit.sendKeys({ paneId: 'w1:p1' }, ['ls\r'])` (the seeded shell) lands in the pane's text
    (`kit.read('w1:p1')` contains it); `kit.sendKeys({ paneId: 'w1:p2' }, ['ok'])` (the seeded agent) still
    rides `agent.send_keys`; `kit.sendKeys({ paneId: 'w9:p9' }, ['x'])` rejects with code `pane_not_found`.
  It exits non-zero on any mismatch, then stops the kit and the fake.
- **Run and capture.** `feature=herdr-close-confirm-keys; entry=@byokit/herdr;
  drive=(node "$scratch_dir/verify-herdr-close-confirm-keys.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **confirm-close shows.** `w2:t1` and `w2:p1` gone, `w2:t2` present.
- **confirm-stale shows.** Three typed rejections, nothing closed.
- **confirm-ladder shows.** `tab-close-would-widen` naming `w3`, then the workspace closes.
- **shell-keys shows.** The shell pane's text gains `ls\r` through `pane.send_keys`; the agent pane through
  `agent.send_keys`; the gone pane surfaces `pane_not_found`.

## Gotchas

- The confirmed close reuses the exact tab close, so a sole tab of its own workspace refuses
  `tab-close-would-widen` — that is the ladder, not a failure: finish with the plain `closeWorkspace`.
- `confirm-stale` needs a real tree change before the retry: split the pane (or move it) after the refusal,
  or the confirmed close succeeds and the stale leg proves nothing.
- The fake's seeded `w1:p1` is the only agentless pane; `w1:p2` carries the seeded agent, so it must keep
  riding `agent.send_keys` — assert both, not just the shell.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
