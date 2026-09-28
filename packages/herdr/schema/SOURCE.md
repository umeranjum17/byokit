# Herdr API schema snapshot — v0.9.1

Pinned input for `scripts/gen-types.ts` (docs/runtime-kits.md §6.7, work package H2).
The snapshot, not muxr's usage, defines the kit's typed surface.

## Release

- Version: **0.9.1** (`herdr --version` → `herdr 0.9.1`)
- Release manifest: `https://herdr.dev/latest.json` (same manifest `herdr update` uses)
- Asset (linux-x86_64):
  `https://github.com/herdrdev/herdr/releases/download/v0.9.1/herdr-linux-x86_64`
- Asset sha256: `2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7`
  (matches the manifest's `sha256["linux-x86_64"]`; recomputed over the downloaded asset)
- Snapshot sha256: `226d4ecbd128d2e6bc84e4c8ddcec21ba9c7e51a0aafffcf087111ead3f1fa9a`
- Bundled schema: `protocol: 22`, `schema_version: 1` (`HERDR_PROTOCOL` in `src/constants.ts`)

## Capture

Captured 2026-09-28 inside an isolated firstmate Herdr lab session
(`fm-lab-byk-h2-schema-*`, never the person's default session), using the
release asset above downloaded into a task-owned directory and a task-owned
empty `HOME`:

```
herdr api schema --output schema/herdr-api-0.9.1.json   # prints the bundled schema, starts no server
```

The tagged release ships no standalone schema file, so the bundled `api schema`
output is the snapshot. Nothing under the task `HOME` was written or read back.

## Generated surface

`scripts/gen-types.ts` derives from this snapshot:

- **Methods** (`src/generated/methods.ts`): the `method` const of each of the
  103 request variants; params from the variant's params `$def`. Results from
  the `success_response` `ResponseResult` union, resolved by (in order):
  exact `method`→const naming (`pane.read`→`pane_read`), unique const prefix
  (`workspace.create`→`workspace_created`, `pane.selection.read`→`pane_selection`),
  the generator's override table, else `unknown` (recorded in `report.json`
  `unmatched`). Override provenance: herdr.dev's Socket API docs, or a probe
  against the isolated lab server (same binary and sha256 as above).
- **Events** (`src/generated/events.ts`): the 27 `events.subscribe` kinds; the
  three filtered kinds carry their filter fields in `HerdrSubscription`, and
  their payloads come from the bundled `subscription_event` schema. Live frames
  observed in the lab: `{ "event": "workspace_created", "data": { "type":
  "workspace_created", … } }` (envelope kind and `data.type` share the
  underscore const).
- **Report** (`src/generated/report.json`): `{ herdr, protocol, schemaVersion,
  methods, events, missing, unmatched }`. `missing` lists muxr-called methods
  absent from the schema (empty for v0.9.1). `unmatched` lists the methods
  whose result type the snapshot does not determine: `server.stop`,
  `server.live_handoff` (server-global, never driven outside the lab's
  lifecycle guards), `command.invoke`, `popup.close`,
  `product_announcement.dismiss`, `release_notes.dismiss` (only error answers
  observable without a matching UI state), `pane.graphics.set`, `agent.focus`,
  `agent.read`, `agent.send_keys` (need a live agent in the pane; reserved for
  H9's lab contract run).

Regenerate with `npm run gen:herdr`; `test/generated.test.ts` fails when the
committed output drifts from a fresh run.
