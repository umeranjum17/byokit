# Changelog

## Unreleased

- Typed device pass-through (G4, docs/runtime-kits.md 7.1/7.2): `herdrDevice(link).call<M>(method, params)` returns
  `HerdrResult<M>` from the generated table, `events()` yields `HerdrLinkEvent` frames, and `./device` re-exports the
  table types. New link ops `hd.kinds` (*view*, `agentKinds()`), `hd.wait` (control, pane in scope) and `hd.subscribe`
  (stream, *view*; filter panes must be in scope, a scoped grant gets only events whose every workspace is in scope)
  with device `agentKinds()`, `wait()` and typed `subscribe(subs, on, onError?)`; a rejected batch or a kit
  disconnect ends the stream (`kit.subscribe` forwards an optional `onError`). The device `terminal()` gains `ready`
  (first frame) and `exited` (`{ reason }`). `hd.call` stays default-denied.

- `words`, `stateWords`, `agentWords` and `WORDS` are exported from `.` and `./device`, so a host or phone UI
  shows the kit's own sentences for Herdr and agent states instead of writing its own.
- FIX the fake Herdr (`./testing`) emits `workspace.created`, `tab.created`, `pane.created`,
  `pane.agent_detected` and the matching `*.closed` events for its own layout changes, so `snapshot()` shows an
  agent started in a new workspace; `herdrContract` holds it (a started agent joins `snapshot()` and its status
  stays current there).
- FIX `hd.prompt` over a link answers a not-ready agent with the `agent.notReady` sentence (and a blocked one
  with `agent.blocked`) instead of the link's generic failure.

- K3 raw event tap: `kit.onEvent(fn)` delivers every event from the kit's own batch and
  per-pane status sockets with wire payloads intact (`pane.moved.previous_pane_id`,
  `workspace.*`), firing on arrival before the snapshot update/refresh (buffered replays never
  re-fire, `subscribe()` sockets are not tapped, the tap opens no socket); plus
  `kit.statusWatchReady()` resolving when the status-watch set has acked. The fake exposes
  `subscriptionCount()` (distinct held subscription sockets).

- FIX docs drift (K10): README pins the v0.9.1 snapshot (protocol 22) instead of the H1
  protocol placeholder; `agents.ts` agrees muxr sends `target_pane_id` to `pane.split`; the
  fake bin's `api schema` reports the pinned identity with no placeholder text.

- `adopt` mode takes `env` and `path` like `own`, merged into the `cli()`/`terminal()` env (so `HOME`,
  `HERDR_CLIENT_SOCKET_PATH`, `HERDR_SESSION` and a `#!/usr/bin/env node` bin work); `TerminalSession.pause()`/`resume()`
  apply backpressure to the Herdr child instead of buffering frames in the host.
- K5 non-fatal start: a rejected `start()` (e.g. `failed/socket` while Herdr is down) may be called again —
  the host comes up while Herdr is down by retrying `start()` in a backoff loop. A failed attempt drops its
  event subscription, and `stop()` drops the closed transport, so a retry or restart dials clean.
- `installedAgentKinds` takes `aliases?: Record<kind, string[]>`: a kind counts as installed when its own
  name or any of its aliases names an executable on the given path (e.g. kind `cursor` with
  `{ cursor: ['cursor-agent'] }` matches a `cursor-agent` binary).

- Lab contract run against real Herdr v0.9.1 (docs/runtime-kits.md §11.3 H9):
  `test/lab/contract.lab.ts` (17 pass, 0 fail; agent cases skipped — the schema has no
  `bash` custom kind — and the live blocked-agent push skipped for the same reason)
  with the result log in `schema/LAB.md`. Covers the H7 link/device/notices/
  terminal-over-link surface over a real Host + DeviceLink pair on loopback. The run
  found and fixed one fake/real disagreement: live frames carry the underscore const
  (`pane_created`) while subscription kinds use dots, so the kit now matches both
  spellings at the event boundary and the fake emits real-style underscore wire frames.
- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.

- Scaffold (docs/runtime-kits.md §11.3 H1): frozen public types, kit facade, internal seams and words. Behavior
  lands in H2–H8; `HERDR_PROTOCOL` is a placeholder until the schema snapshot (H2).
- Wire `HerdrKit.cli`/`terminal` to `runCli`/`openTerminal` with the supervisor env (6.5), export
  `./testing`, and run `herdrContract` against `startFakeHerdr` in `test/contract.test.ts`.
