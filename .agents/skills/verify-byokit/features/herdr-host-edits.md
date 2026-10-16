# Herdr host edits: a host renames, focuses and lays out with typed kit methods, never raw Herdr calls

`HerdrKit.rename`, `focus` and `layout` take the `herdrDevice` shapes (`HerdrRename`, `HerdrTarget`,
`HerdrLayout`) on the host. `rename`/`focus` map exactly one pane, tab or workspace to `pane.*`/`tab.*`/
`workspace.*`; `layout` passes every `layout.apply` option (`root`, `focus`, `tabId`, `workspaceId`,
`tabLabel`) through and answers Herdr's result. A Herdr refusal keeps Herdr's own code and sentence; a target
that is not exactly one rejects before any call.

## Sub-features

- `rename`: a tab and a pane renamed through the kit read back with the new label from `tab.get`/`pane.get`.
- `focus`: `kit.focus({ pane })` reads back `focused: true` on that pane from `pane.get`.
- `layout`: `kit.layout({ workspaceId, tabLabel, focus: false, root })` answers the applied tree; the real
  server lays it out in a fresh tab carrying `tabLabel`, and `pane.layout` reads the split ratio back as rects.
- `refusals`: an unknown pane rejects `herdr: pane_not_found: pane <id> not found` with `code: 'pane_not_found'`;
  `kit.focus({})` rejects `herdr: focus picks exactly one of pane, tab or workspace`.

## How to get to it (user POV)

`new HerdrKit({ mode: 'adopt', bin: 'herdr', socketPath })` from `@byokit/herdr`, `await kit.start()`, then
the three methods (packages/herdr/README.md, API at a glance).

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md); `/usr/bin/herdr` prints `herdr 0.9.1`; an **isolated,
non-default Herdr session** provisioned and torn down by the environment's Herdr lab helper, whose socket the
drive receives as `HERDR_LAB_SOCKET`. Never adopt the person's own Herdr session. No agent CLI is needed.

- **Write the consumer.** `"$scratch_dir/verify-herdr-host-edits.mjs"` importing `HerdrKit` from
  `@byokit/herdr`. It adopts the lab socket, creates a workspace (`workspace.create { cwd: '/tmp', focus: false }`)
  and splits its root pane right, then prints after each step what Herdr reads back:
  `kit.rename({ tab })` and `kit.rename({ pane })` → `tab.get`/`pane.get` labels; `kit.focus({ pane })` →
  `pane.get` `focused`; `kit.layout({ workspaceId, tabLabel, focus: false, root: split down 0.3 })` → the
  result, `pane.layout` rects of its first leaf and `tab.get` of the returned `tab_id`; then the two refusals,
  and `kit.refresh()` + `kit.snapshot()` tabs. It exits non-zero on any mismatch, then `kit.stop()`.
- **Run and capture.** `feature=herdr-host-edits; entry=@byokit/herdr; drive=(<lab wrapper> node "$scratch_dir/verify-herdr-host-edits.mjs")`,
  where the wrapper provisions the lab session, sets `HERDR_LAB_SOCKET` from the helper's `session list --json`
  `socket_path`, and tears down on EXIT; then run SKILL.md Evidence's capture block. Exit code `0`, teardown `0`.
- **rename shows.** The tab and pane labels read back equal the labels sent.
- **focus shows.** The focused pane reads back `focused: true`.
- **layout shows.** A new `tab_id` labelled `tabLabel`; the first leaf's rect height is about 30% of the tab.
- **refusals show.** The `pane_not_found` message and code verbatim, and the exactly-one sentence.

The same journey runs as a contract case (`contract: host rename, focus and layout land in Herdr and read back`)
on the fake in `npm test` and on the lab session with `HERDR_LAB_SOCKET=<socket> node packages/herdr/test/lab/host-ops.lab.ts`.

## Gotchas

- The real `layout.apply` replaces nothing in place: it builds a fresh tab with fresh panes (new ids) and leaves
  the old tab; the fake moves the named panes inside the existing tab. Read the result's ids, never the ones sent.
- A fresh lab session has no workspace until the drive creates one (`w1`).
