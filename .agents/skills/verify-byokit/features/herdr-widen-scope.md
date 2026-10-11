# Herdr close guards: a refused widening close names the wider target and says so in words

When a close would widen — the last pane of a tab, the only tab of a workspace, or a worktree-group root —
the kit refuses it. Now the refusal also tells the app *which bigger thing* it would close instead, as
`{ scope: 'tab' | 'workspace', id, label }` on the thrown error (codes unchanged), and over a link the
phone hears the kit's plain `close.wouldWiden` sentence instead of a bare "failed".

## Sub-features

- `kit-pane`: `kit.closePane` on the last pane of a tab throws `pane-close-would-widen` with `{ scope: 'tab', id, label }` of that tab.
- `kit-tab`: `kit.closeTab` on the only tab of a workspace throws `tab-close-would-widen` with `{ scope: 'workspace', id, label }` of that workspace.
- `kit-workspace`: `kit.closeWorkspace` on a worktree-group root throws `workspace-close-would-widen` with `{ scope: 'workspace', id, label }` of the group, named by its root workspace.
- `phone-words`: over a real `@byokit/pair` link, a control device's `hd.close` of that pane or the only tab rejects with the `close.wouldWiden` words ("Closing this would close more than you picked. Close the bigger one instead.").

## How to get to it (user POV)

- Adopt the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`
  (packages/herdr/README.md).
- Host side: `Host.open({ ..., ...herdrLink(kit, { scopeOf }) })` (`@byokit/herdr/link`) over a loopback
  `node:http` server whose `WebSocketServer` accepts into `host.accept(ws)`; pair a control grant with
  `pairWithOffer` (`@byokit/pair`) and drive it with `herdrDevice(link)` (`@byokit/herdr/device`).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in Herdr
serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-widen-scope.mjs"` importing `HerdrKit` and `words`
  from `@byokit/herdr`, `herdrLink` from `@byokit/herdr/link`, `herdrDevice` from `@byokit/herdr/device`,
  `startFakeHerdr` from `@byokit/herdr/testing`, and `DeviceLink`, `Host`, `keyPair`, `pairWithOffer` from
  `@byokit/pair`. It starts the fake and kit, opens the Host/link, then asserts each leg:
  - `kit-pane` / `kit-tab`: `kit.call('workspace.create', { cwd: '/tmp/verify-widen', label: 'Review' })`
    returns a workspace whose one tab has one pane; `kit.closePane(`${w2}:p1`)` is caught and its
    `{ code, scope, id, label }` equals `{ pane-close-would-widen, tab, ${w2}:t1, main }`, and
    `kit.closeTab(`${w2}:t1`)` equals `{ tab-close-would-widen, workspace, w2, Review }`.
  - `kit-workspace`: `kit.startAgent({ kind: 'pi', cwd: '/tmp/verify-widen', place: { workspace: 'new' },
    worktree: { branch: 'verify' } })` links a checkout into w1's group; `kit.closeWorkspace('w1')` is caught
    and its `{ code, scope, id, label }` equals `{ workspace-close-would-widen, workspace, w1, <w1 label> }`.
  - `phone-words`: `host.offer({ role: 'control', urls: [url], meta: { scope: { workspaces: 'all' } } })`,
    pair, `new DeviceLink(grant, { store })`, wait `link.status === 'online'`, then `herdrDevice(link)`:
    `hd.close({ pane: `${w2}:p1` })` and `hd.close({ tab: 'w1:t1' })` both reject with a message equal to
    `words('close.wouldWiden')`.
  It exits non-zero on any mismatch, then closes the link, host, server, kit and fake.
- **Run and capture.** `feature=herdr-widen-scope; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-widen-scope.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **kit-pane shows.** `{ code: 'pane-close-would-widen', scope: 'tab', id: <tab>, label: 'main' }`.
- **kit-tab shows.** `{ code: 'tab-close-would-widen', scope: 'workspace', id: <w2>, label: 'Review' }`.
- **kit-workspace shows.** `{ code: 'workspace-close-would-widen', scope: 'workspace', id: 'w1', label: <w1 label> }`.
- **phone-words shows.** Both `hd.close` rejections carry the plain `close.wouldWiden` sentence, and the workspace count is unchanged.

## Gotchas

- The fake seeds w1 with one tab (`w1:t1`) holding two panes, so closing `w1:p1` does **not** widen; use a
  fresh `workspace.create` (one tab, one pane) for `kit-pane` / `phone-words`, or `hd.close({ tab: 'w1:t1' })`
  for the tab case.
- The worktree-group guard needs `worktree.create` (through `kit.startAgent({ worktree })`); only then does
  w1 share a `repo_key` with a linked checkout and widen on close.
- The workspace-group error is named by its root workspace (scope `workspace`, that root's id and label): the
  group is anchored at the non-linked root, and the kit has no separate group id.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`, and close
  the WebSocket server and socket before the HTTP server.
