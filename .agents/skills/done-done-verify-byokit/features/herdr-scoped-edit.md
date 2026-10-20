# Herdr scoped edits: a paired phone can rename, focus and lay out only what it is scoped to

A control device paired to the Herdr host can rename, focus and lay out a pane, tab or workspace — but only
one inside its grant's scope, and never through `hd.call`. `hd.rename`, `hd.focus` and `hd.layout` copy
`hd.close`'s rule: a target outside `scopeOf(grant)` (or an unknown one) refuses with the `link.notAllowed`
sentence and makes no Herdr call; a `view` grant is refused. Each maps to the typed `pane.rename`/`tab.rename`/
`workspace.rename`, `pane.focus`/`tab.focus`/`workspace.focus` and `layout.apply` calls in the generated table.

## Sub-features

- `rename`: `hd.rename({ workspace | tab | pane, label })` reaches the typed rename; an in-scope workspace or tab
  rename shows in the next `hd.tree`, and a long label (the pinned schema declares no cap) arrives intact.
- `focus`: `hd.focus({ pane | tab | workspace })` reaches the typed focus for the intended target.
- `layout`: `hd.layout({ root, focus?, tabId?, tabLabel?, workspaceId? })` reaches `layout.apply` for the tab or
  workspace it names; the returned layout names that target.
- `refusals`: an out-of-scope anchor (a valid pane/tab in another workspace) and a `view` grant each reject with
  the `link.notAllowed` words and change nothing; a missing target, or a `layout` naming both a `tabId` and a
  `workspaceId`, is refused before any Herdr call; a `layout` naming an out-of-scope or unknown `pane_id` leaf
  rejects with the `link.notAllowed` words and changes nothing.

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

- **Write the consumer.** `"$scratch_dir/verify-herdr-scoped-edit.mjs"` importing `HerdrKit` from
  `@byokit/herdr`, `herdrLink` from `@byokit/herdr/link`, `herdrDevice` from `@byokit/herdr/device`,
  `startFakeHerdr` from `@byokit/herdr/testing`, and `DeviceLink`, `Host`, `keyPair`, `pairWithOffer` from
  `@byokit/pair`. It starts the fake and kit, opens the Host/link, and asserts each leg:
  - `rename`: with a `control` grant scoped `{ workspaces: ['w1'] }`, `hd.rename({ workspace: 'w1', label: L })`
    with a 200-character `L` then `hd.tree()` shows `w1`'s label `=== L`; `hd.rename({ tab: 'w1:t1', label: L })`
    shows the tab label `=== L`; `hd.rename({ pane: 'w1:p1', label: L })` leaves the fake's pane label `L`.
  - `focus`: `hd.focus({ pane: 'w1:p2' })` leaves the fake's focused pane `w1:p2`; `hd.focus({ tab: 'w1:t1' })`
    the focused pane's tab `w1:t1`; `hd.focus({ workspace: 'w1' })` the focused workspace `w1`.
  - `layout`: a `control` all-scope grant first creates a second workspace `w2`, then
    `hd.layout({ tabId: 'w2:t1', root: { type: 'pane', pane_id: 'w2:p1' }, focus: true })` resolves with
    `layout.tab_id === 'w2:t1'` and `layout.workspace_id === 'w2'`.
  - `refusals`: the narrow grant's `hd.rename`/`hd.focus` on `w2`'s valid pane, tab and workspace, and its
    `hd.layout` on `w2:t1`, each reject with a message equal to `words('link.notAllowed')`, and the fake's
    `w2` label, focus and pane rect are unchanged; `hd.layout` naming both `w1:t1` and `w2` rejects before any
    call; `hd.layout({ tabId: 'w1:t1', root: { type: 'pane', pane_id: 'w2:p1' } })` (and an unknown `w9:p9` leaf)
    rejects with `words('link.notAllowed')` and leaves the in-scope pane's rect unchanged; a `view` all-scope grant
    rejects all three in scope; a `rename` with no target, a `focus` with no target and a `layout` with no target
    all reject.
  It exits non-zero on any mismatch, then closes the link, host, server, kit and fake.
- **Run and capture.** `feature=herdr-scoped-edit; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-scoped-edit.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **rename shows.** `w1` and `w1:t1` labels equal the 200-character label; the fake pane `w1:p1` label is it.
- **focus shows.** The fake's focused pane/tab/workspace follow the typed target each time.
- **layout shows.** The applied layout names `w2:t1` / `w2`.
- **refusals show.** Each out-of-scope or view-only edit rejects with the `link.notAllowed` sentence and the
  `w2` world is untouched.

## Gotchas

- The fake does not emit an event for `pane.rename`, so a pane rename is proved through the fake's world (its
  recorded label), not the next `hd.tree`; workspace and tab renames do emit and refresh the tree.
- The fake does not emit focus events either, so `hd.focus` is proved through the fake's focused flags.
- A missing or dual target fails `handle` with a host-side validation error, which pair surfaces to the device
  with its own generic words (not the `link.notAllowed` sentence); only the scope/role refusals carry that sentence.
- Create `w2` with an all-scope grant and surface it with `fake.emit({ type: 'workspace.created', workspace_id })`
  (the fake does not broadcast creates), then wait for the wide grant's tree to hold it before narrowing.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`, and close
  the WebSocket server and socket before the HTTP server.
