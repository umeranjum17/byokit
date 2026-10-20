# Herdr fake focus and export: directional focus and layout export on the stand-in

The kit's stand-in Herdr answers `pane.focus_direction` and `layout.export` with the pinned
shapes, so a mirror's tests drive the fake instead of their own. Directional focus moves to the
overlapping neighbour past the source edge and takes focus there; at an edge — nothing past it —
the answer keeps the source focused with `reason: 'no_neighbor'`. The export answers the tab's
current geometry as a `LayoutDescription` whose split tree names every live pane as a leaf.

## Sub-features

- `focus-move`: `pane.focus_direction` past a shared edge answers `changed: true` with the
  neighbour as `focused_pane_id`, and the neighbour reads back `focused: true` from `pane.get`.
- `focus-edge`: past an outer edge it answers `changed: false`, `reason: 'no_neighbor'`, focus
  unmoved; an unknown pane rejects `pane_not_found`.
- `export`: `layout.export` by `tab_id` and by `pane_id` answers the same tab with every live pane
  as a root leaf; an unknown tab rejects `tab_not_found`.

## How to get to it (user POV)

Adopt the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
`new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`
(packages/herdr/README.md). Create a workspace, split its root pane right, apply a right split,
then call the two methods raw with `kit.call`.

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the stand-in
serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-fake-focus.mjs"` importing `HerdrKit`
  from `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and
  kit, creates a workspace, splits right, applies a right 0.5 split, and reads the neighbour ids
  back from the applied tree. Then it prints after each step what the fake reads back:
  `pane.focus_direction` right from the first leaf (changed, neighbour focused, `pane.get`
  confirms), right from the second leaf (unchanged, `no_neighbor`), left back across the split,
  up from a full-height pane (`no_neighbor`), and the unknown-pane refusal; `layout.export` by
  tab and by pane (same tab, both panes as leaves), and the unknown-tab refusal. It exits
  non-zero on any mismatch, then closes the kit and fake.
- **Run and capture.** `feature=herdr-fake-focus; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-fake-focus.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **focus-move / focus-edge show.** `changed: true` with the neighbour focused, then
  `changed: false` with `reason: 'no_neighbor'` and focus unmoved, plus the `pane_not_found` refusal.
- **export shows.** Both address forms name the same tab with both panes as leaves, plus the
  `tab_not_found` refusal.

The same journey runs as contract cases (`contract: pane.focus_direction moves focus to the
neighbour and holds at an edge`, `contract: layout.export returns the tab layout with every live
pane as a leaf`) on the fake in `npm test`, with lab-adapted twins in
`packages/herdr/test/lab/contract.lab.ts` for the real server.

## Gotchas

- Real `layout.apply` lays out fresh panes (new ids) while the fake moves the named panes in
  place: read the neighbour ids back from the applied tree, never reuse the ones sent
  (packages/herdr/README.md does not promise id stability across apply).
