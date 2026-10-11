# Herdr waitPromptable: wait until a just-started agent can take a prompt

A consumer app starts a Herdr agent and does not want to poll `prompt` until it stops catching
`agent-not-ready`. It calls `kit.waitPromptable(agent, { timeoutMs })` once: the wait resolves as soon
as the kit's own snapshot is promptable (the same rule `prompt` uses, exported as `isPromptable`), rejects
with code `agent-not-ready` at the deadline, and rejects with code `pane-unavailable` if the pane closes
while waiting — so it never hangs.

## Sub-features

- `pending-timeout`: an agent whose launch has not settled (`launch_pending: true`) is not promptable, so the wait rejects `agent-not-ready` at the deadline.
- `resolves-ready`: once the fake flips the launch ready, the wait resolves on its own snapshot and `isPromptable` reads true.
- `pane-closed`: a pane closed while the wait is running rejects `pane-unavailable` within the timeout.

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`, then
  `kit.waitPromptable({ paneId: 'w1:p2' }, { timeoutMs })` (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress: the kit's stand-in
Herdr serves a real Unix socket under the scratch directory and answers the pinned protocol.

- **Write the consumer.** `"$scratch_dir/verify-herdr-wait-promptable.mjs"` importing `HerdrKit` and
  `isPromptable` from `@byokit/herdr`, and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake
  and the kit, then for each leg asserts the outcome and prints the caught error's `code`:
  - `pending-timeout`: set `fake.world.agents.find((a) => a.pane_id === 'w1:p2').launch_pending = true`, then
    `await kit.waitPromptable({ paneId: 'w1:p2' }, { timeoutMs: 120 })` is expected to reject `agent-not-ready`.
  - `resolves-ready`: start `const waiting = kit.waitPromptable({ paneId: 'w1:p2' }, { timeoutMs: 2000 })`, set
    the same agent's `launch_pending = false`, `await waiting`, and print `isPromptable(agent)` from the snapshot.
  - `pane-closed`: set `launch_pending = true` again, start `kit.waitPromptable({ paneId: 'w1:p2' }, { timeoutMs: 2000 })`,
    `await kit.closePane('w1:p2')` (the tab holds two panes, so the close guard passes), and expect `pane-unavailable`.
  It exits non-zero on any mismatch, then `await kit.stop()` and `await fake.stop()`.
- **Run and capture.** `feature=herdr-wait-promptable; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-wait-promptable.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **pending-timeout shows.** `agent-not-ready` after ~120 ms.
- **resolves-ready shows.** The wait resolves and `isPromptable`/status is promptable (`idle`).
- **pane-closed shows.** `pane-unavailable` within the 2 s timeout.

## Gotchas

- `launch_pending` rides `agent.get` reads only, never a status push; `waitPromptable` re-reads the snapshot each
  pass, so mutating `fake.world` is enough — no event has to be emitted.
- Use `kit.closePane('w1:p2')`, not a bare `pane.close` emit: the fake must also drop the agent so `agent.get`
  answers `agent_not_found` (the `pane-unavailable` probe).
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
