# Changelog

## Unreleased

## 0.7.1 (2026-10-07)

- Dependency update: pins @byokit/relay 0.5.3.
- Dependency update: pins @byokit/link 0.7.1.

- `move` and `moveToAccount` no longer type env prep into the new pane: the split placement env is verified silently through `pane.get` (set vars exact, unset vars absent, fail closed), so no `unset` lines, echo probes or account folder values stay in the scrollback after a move.
- The replacement agent keeps the conversation's name: it starts unique while the source is still live, then takes the source's session name through `agent.rename` once the source pane closes (best-effort; a refused rename never fails the move). New panes no longer show `move-<hex>` names.
- The quickstart now says what to read next (the kit spec's decisions and work packages, then the two ways in
  and agent readiness). Docs only; no typed surface changed.
- The `relay` option takes anything with `RelayClient`'s `notify`, so a host can hand the kit a relay it opens after `Host.open` (the client needs the open host). A `RelayClient` still fits; behaviour is unchanged.
- Unreleased source dependency metadata: pin @byokit/seal 0.3.0 and @byokit/relay 0.5.2; this package's existing version is not republished. Previously published consumer metadata remains unchanged.
- `startAgent` with a record `env` that sets `HOME` now also places the pane's XDG config, data, state and cache directories under that home (unless set), so a sign-in inside the pane stays in the task-owned home instead of the server's.

## 0.7.0 (2026-10-02)

- Includes the Muse installation, managed-kind discovery and isolated readiness FIX/SECURITY changes recorded in the unpublished 0.6.0 preparation below; none add native login qualification.

FIX: Re-read source quiescence, conversation, terminal and published sequence immediately before closing on every account move; roll back replacements on change and verify surviving conversations after uncertain cleanup. Published Herdr has no atomic conditional close.
FIX: Add explicit confirmed, bounded `whenBusy: { busy: 'wait', confirmed, waitMs }` account handoff: move when this step finishes, never interrupt. Preserve default busy refusal, refuse missing sequence/stale identity, stop on blocked approvals, and return typed `interrupt_unsupported` without keys or lifecycle calls. Native working-step qualification remains separate from offline protocol fixtures.

## 0.6.0 (2026-10-02)

- SECURITY: Explicit Muse installation uses private staged HOME/XDG/temp paths, a clean environment, bounded HTTPS downloads and owned-process cancellation; it never imports personal credentials, edits shell profiles, or starts automatic login or updates.
- FIX: Missing Muse on the effective private launch PATH now reports not installed and refuses before pane placement or start instead of showing a fake installation and waiting for the startup timeout. The explicit official installer returns verified local release paths for launch; account/catalog readiness remains unknown.

FIX: Discover every pinned agent kind and use its actual account-folder and resume support for sign-in tabs and managed moves. Kinds without a folder override remain one sign-in per computer user, tab only. New move support is fixture-tested, not native-qualified.

SECURITY: Readiness no longer probes default CLI logins. Pass `agentStatus(kinds, { folders: { [kind]: appManagedFolder }, env? })` to select an app-owned account; absent or invalid folders return unknown without running a CLI. Status commands receive a clean env with HOME/XDG/platform directories confined to that folder. Direct `runStatusCommand` calls without an explicit HOME return no answer. Injected status runners now receive the resolved executable path and explicit env (not an inherited default login).

## 0.5.0 (2026-10-01)

- SECURITY: StartAgent and openSignInTab accept a clean launch environment with explicit unsets, verified before launch in idle shells on new or existing panes; credential values stay out of terminal commands, argv and errors, preventing inherited API key (billed per use) variables from overriding subscription sign-in.

## 0.4.1 (2026-10-01)

- Dependency update: pins @byokit/relay 0.5.1.

- FIX: Preserve the ready replacement after a lost source-close acknowledgment unless fresh reads verify the original conversation survived; report only a verified recovery conversation, or omit `live` when verification is unavailable.

## 0.4.0 (2026-10-01)

- Dependency update: pins @byokit/reach 0.6.0.

- Add `move` with caller resume args, credential shedding, staging/replacement hooks and `MoveResult.paneId`.
- Add per-call `cli` env overlays for managed folder hook installation.
- Report surviving replacement panes when environment verification rollback fails; refuse folder moves for agents that ignore the folder variables.
- Track a subscription agent's turn with `runTurn` and `onTurnEnd`: acknowledged Herdr status
  events, optional JSON validated by the app's schema validator, and changed files from bounded
  before/after snapshots of the app-owned working directory. No additional API billing path.

## 0.3.0 (2026-10-01)

- Dependency update: pins @byokit/reach 0.5.0.
- Dependency update: pins @byokit/relay 0.5.0.
- Dependency update: pins @byokit/link 0.7.0.

- `PromptReceipt.agentSession` optionally identifies the conversation from the prompt response without an extra read.

- FIX: Refuse non-empty `StartAgent.env` on existing panes instead of silently using the old subscription.
- Move a conversation to another subscription account with `moveToAccount`: verify the target shell folder,
  resume and wait before closing the original pane, and roll back the new pane on failure.
- Open each CLI’s own sign-in in an account-specific tab with `openSignInTab` and the host’s explicit env.

- `HerdrKit.startAgent` lifecycle events: `installing` (with the progress words) before a start
  that needs an install, `ready` with the fresh ref, and `launchFailed` with a typed reason
  (`placement-failed` | `pane-busy` | `install-failed` | `start-rejected`) plus plain words —
  subscribable per call (`StartAgent.onEvent`) or app-wide (`kit.onStartAgent`), no polling.
  The shape and rejection are unchanged. Install detection (`agentInstallState`, also on
  `agentStatus` as `installState`) tells a real runnable binary apart from an auto-install
  launcher such as a mise shim: shimmed or absent reads `installs-on-first-start`, sharing the
  one probe path with `installedAgentKinds` (`resolveAgentBinary`, `isAutoInstallShim`).


## 0.2.0 (2026-09-30)

- `HerdrKit.agentStatus(kinds)` (B5): per-kind onboarding readiness — installed plus CLI
  sign-in (`yes`/`no`/`unknown`) from each CLI's own non-secret status command (`claude auth
  status`, Codex `app-server` `account/read`; `unknown` where a CLI has none), install and
  sign-in hint words, and the extra install dirs (mise shims, `~/.local/bin`, Homebrew) moved
  in from muxr's PATH probe. Pi reads `installed: false` with `installs on first start`. The
  command runner is injectable for tests; credential files are never read.

## 0.1.10 (2026-09-30)

- Dependency update: pins @byokit/relay 0.4.2.
- Dependency update: pins @byokit/link 0.6.0.

## 0.1.9 (2026-09-30)

- Dependency update: pins @byokit/relay 0.4.1.
- Dependency update: pins @byokit/link 0.5.1.
- FIX: (from @byokit/link 0.5.1) Reject an authenticated empty transport frame instead of decoding it as an empty control message.

## 0.1.8 (2026-09-30)

- Depends on @byokit/relay 0.4.0.

## 0.1.7 (2026-09-30)

- Depends on @byokit/relay 0.3.1.
- Depends on @byokit/reach 0.4.0.
- Depends on @byokit/link 0.5.0.
- FIX: (from @byokit/link 0.5.0) `decodeOffer()` reads legacy compact direct pairing codes with checksum, padding, bounds and expiry validation; new encodings keep the complete current format.

- Dependency update: pins @byokit/link 0.5.0, @byokit/reach 0.4.0 and @byokit/relay 0.3.1.

## 0.1.6 (2026-09-30)

- Depends on @byokit/relay 0.3.0.

## 0.1.5 (2026-09-30)

- Depends on @byokit/relay 0.2.2.
- Depends on @byokit/link 0.4.0.

- The test fake's `fake.stream` ends with one `fake.stream.done` line on the same ordered byte stream, so the
  paused-terminal backpressure test asserts delivery causally instead of on a wall-clock wait.

## 0.1.4 (2026-09-30)

- Preserve seed-based notice opening with @byokit/seal 0.2.0.

## 0.1.3

- Depends on @byokit/reach 0.3.0.

## 0.1.2 (2026-09-29)

- FIX: `prompt` now reaches an agent that was already running when the app connected. Herdr marks only
  the agents its own `agent.start` launched as interactive-ready, so an agent started by hand or by
  another app was refused forever; and a snapshot read while an agent was still launching kept it
  marked as launching, because Herdr never pushes the end of a launch. The kit no longer gates on
  interactive-ready, and before refusing a prompt it re-reads the agent once from Herdr.
- FIX: when Herdr itself refuses a prompt as not ready, `prompt` now fails with `agent-not-ready`
  like the kit's own check, not with Herdr's raw `agent_not_ready` error.
- The test fake leaves `launch_pending` and `interactive_ready` out when they are false, as Herdr v0.9.1 does.
- Depends on @byokit/relay 0.2.1.

## 0.1.1 (2026-09-29)

- SECURITY: (from @byokit/relay 0.2.0) Removing a phone now reliably stops its push notifications, even if the relay was down or restarting when you removed it. Before, `RelayClient.revoke` dropped the device's grant and sent one unsubscribe that was lost if the offline queue overflowed or the host stopped or restarted before the relay was back, so the relay kept the phone's push address. Now the unsubscribe is saved first and resent on every connection until the relay confirms it; `revoke()` resolves then. Pass a durable `store` to `RelayClient` so a pending unsubscribe survives a restart (the default is memory).
- FIX: `prompt` now reaches an idle agent that was already running when the app connected. The kit
  read every live status push as the agent kind (the push carries the kind as a plain `agent`
  string) and dropped the status, so an agent caught at `unknown` stayed there and the readiness
  gate refused every prompt. The push now lands; and a status change between the snapshot read and
  the per-pane watch's ack, which reached no socket, is re-read once the watch is live.
- FIX subscribe errors and type (K4): `kit.subscribe(subs, on, onError?)` forwards `onError`
  to the transport and returns its control surface (`HerdrSubscribeStop`: `ready`/`onReconnect`/
  `onDisconnect`); a rejected filtered batch reports `invalid_subscription` once and never retries.
  The kit's own event and per-pane watches log rejections to a new `HerdrKitOptions.onLog` hook
  instead of swallowing them.
- Depends on @byokit/relay 0.2.0.
- Depends on @byokit/link 0.3.2.
- K8 fake coverage (`./testing`): `fake.world` is the live mutable world the server answers from
  (seeded ids via `world.seed`, seeded plugins via `world.plugins`); `workspace.rename`, `tab.rename`,
  `pane.rename` and `agent.rename` (refusing bad names with `invalid_agent_name` and taken ones with
  `agent_name_taken`); `plugin.list`; the boot-window `agent.start` reply both shapes read
  (`{ type: 'agent_started', agent, argv }`); filtered emit with `watching()`, `snapshotCount()` and the
  `holdSnapshot`/`failNextSnapshot`/`holdAck`/`failNextAck` hooks; real terminal frames
  (`{ type: 'terminal.frame', full, bytes }` plus the `data` alias) with `terminal.resize`/`terminal.input`;
  scroll state on `pane.get` with `pane.scroll`; and `api schema` printing the pinned v0.9.1 snapshot.

## 0.1.0 (2026-09-29)
- Opt-in pinned Herdr fetch (G11, `./binary`): `ensureHerdr({ dir, platform? })` (also spelled
  `fetchHerdr`) downloads the pinned v0.9.1 asset for the current platform into an app-owned `dir`
  only when called, verifies it against a committed per-platform sha256 table (linux x64/arm64,
  darwin x64/arm64 — each hash recomputed over the official release asset), writes atomically, marks
  executable, and returns the absolute `own`-mode `bin`. Never PATH, never `~/.local/bin`, nothing on
  install or import; a hash mismatch (nothing left behind) or unsupported platform fails in plain words.
- K11 protocol range: `HerdrKitOptions` takes `protocolRange?: { min?: number; max?: number }`
  (each bound defaults to the pinned `HERDR_PROTOCOL`). A server below the floor still fails
  closed; a newer server is the steady state `needs-update`/`version` instead of a throw — the
  snapshot installs and the kit stays usable — so a Herdr protocol bump does not take the host
  down before the kit's pin moves.
- Typed device pass-through (G4, docs/runtime-kits.md 7.1/7.2): `herdrDevice(link).call<M>(method, params)` returns
  `HerdrResult<M>` from the generated table, `events()` yields `HerdrLinkEvent` frames, and `./device` re-exports the
  table types. New link ops `hd.kinds` (*view*, `agentKinds()`), `hd.wait` (control, pane in scope) and `hd.subscribe`
  (stream, *view*; filter panes must be in scope, a scoped grant gets only events whose every workspace is in scope)
  with device `agentKinds()`, `wait()` and typed `subscribe(subs, on, onError?)`; a rejected batch or a kit
  disconnect ends the stream (`kit.subscribe` forwards an optional `onError`). The device `terminal()` gains `ready`
  (first frame) and `exited` (`{ reason }`). `hd.call` stays default-denied.
- K2 snapshot fields: `snapshot()` carries the agent (`agentSession`, `displayAgent`, `title`,
  `foregroundCwd`), pane (`label`, `focused`, `terminalTitle` from `terminal_title_stripped`, `tokens`)
  and workspace (`focused`, `number`, `tokens`, `worktree` in camelCase) fields; `pane.updated`
  titles and labels merge in place with no re-bootstrap; a per-pane lifecycle epoch keeps a status
  push that races a snapshot read (the live status and revision win over the read). The fake seeds
  and serves every field (agent `title`, workspace `number`/`tokens`, `workspace.report_metadata`).

- `words`, `stateWords`, `agentWords` and `WORDS` are exported from `.` and `./device`, so a host or phone UI
  shows the kit's own sentences for Herdr and agent states instead of writing its own.
- FIX `herdrDevice(link).events()` ends its link stream when the reader stops (`break`, or `return()` from a
  view that stops watching), even while it waits for the next frame; before, the stream stayed open and the
  `return()` never settled.
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
- FIX: match both event spellings at the event boundary: live frames on real Herdr carry
  the underscore const (`pane_created`) while subscription kinds use dots. 0.1.0-next
  matched dots only, so no live `created`/`closed`/status event ever updated the tree.
- `herdrContract(make, { test })` accepts the runner's `test` (node:test's by default), so a vitest host suite can run the contract against its lab Herdr.
- K7 `startAgent` parity: `agent_pane_busy`/`agent_pane_unavailable` retry inside a bounded 5 s
  budget, `pane.close` rollback of the created pane when `agent.start` fails (a caller-owned `pane`
  placement is never closed), `focus: false` with the env on `worktree.create`, an optional
  `worktree.branch`, and an `agentStartFaults` hook on the fake scripting `agent.start` failures; the
  fake's `worktree.create` opens the linked checkout with its root tab and pane like the pinned server,
  and every placement records its env on the fresh pane where `pane.get` surfaces it.
- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.

- Scaffold (docs/runtime-kits.md §11.3 H1): frozen public types, kit facade, internal seams and words. Behavior
  lands in H2–H8; `HERDR_PROTOCOL` is a placeholder until the schema snapshot (H2).
- Wire `HerdrKit.cli`/`terminal` to `runCli`/`openTerminal` with the supervisor env (6.5), export
  `./testing`, and run `herdrContract` against `startFakeHerdr` in `test/contract.test.ts`.
