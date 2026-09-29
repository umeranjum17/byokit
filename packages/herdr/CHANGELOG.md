# Changelog

## Unreleased

- K3 raw event tap: `kit.onEvent(fn)` delivers every event from the kit's own batch and
  per-pane status sockets with wire payloads intact (`pane.moved.previous_pane_id`,
  `workspace.*`), firing on arrival before the snapshot update/refresh (buffered replays never
  re-fire, `subscribe()` sockets are not tapped, the tap opens no socket); plus
  `kit.statusWatchReady()` resolving when the status-watch set has acked. The fake exposes
  `subscriptionCount()` (distinct held subscription sockets).

- FIX docs drift (K10): README pins the v0.9.1 snapshot (protocol 22) instead of the H1
  protocol placeholder; `agents.ts` agrees muxr sends `target_pane_id` to `pane.split`; the
  fake bin's `api schema` reports the pinned identity with no placeholder text.

- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.

- Scaffold (docs/runtime-kits.md §11.3 H1): frozen public types, kit facade, internal seams and words. Behavior
  lands in H2–H8; `HERDR_PROTOCOL` is a placeholder until the schema snapshot (H2).
- Wire `HerdrKit.cli`/`terminal` to `runCli`/`openTerminal` with the supervisor env (6.5), export
  `./testing`, and run `herdrContract` against `startFakeHerdr` in `test/contract.test.ts`.
