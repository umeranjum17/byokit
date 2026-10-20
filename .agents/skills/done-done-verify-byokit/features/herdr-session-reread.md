# Herdr sessionless re-read: a session that appears lands with no host re-read

Some agents (Codex, for one) have no Herdr session when Herdr first detects them. The host used to
schedule its own re-read to pick the session up. Now the kit re-reads the agent (`agent.get`) when its
status watch acks and on each later status push until the session lands, and the session reaches the
tree and `onChange` on that read. The host schedules nothing.

## Sub-features

- `session-reread`: a detected agent with no session shows `agentSession` undefined; the session reported silently, then the agent's next status push, puts `agentSession` in the tree and the status moves to `working`.

## How to get to it (user POV)

- The consumer adopts the kit's stand-in Herdr: `startFakeHerdr` (`@byokit/herdr/testing`), then
  `new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })`, `await kit.start()`,
  then read `kit.snapshot()` (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress.

- **Write the consumer.** `"$scratch_dir/verify-herdr-session-reread.mjs"` importing `HerdrKit` from `@byokit/herdr`
  and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and the kit, then:
  - Add a sessionless agent row to the live world: copy `fake.world.agents[0]`, set `pane_id: 'w1:p1'`,
    `tab_id: 'w1:t1'`, `workspace_id: 'w1'`, `agent: 'codex'`, `name: 'codex'`, and delete `agent_session`
    (`fake.world.agents.push(row)`).
  - `fake.emit({ type: 'pane.updated', pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', label: 'codex', agent: 'codex', agent_status: 'idle', focused: false, revision: 2, terminal_id: 'term-w1:p1' } })`,
    wait until `fake.watching('w1:p1') === true` and `await kit.statusWatchReady()`; assert the pane's `agent.agentSession` is undefined.
  - Set `row.agent_session = { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'thread-1' }` on the same row object (no event),
    then `fake.setStatus('w1:p1', 'working')`.
  - Wait until the snapshot pane's `agent.agentSession.value === 'thread-1'` and assert `agent.status === 'working'`.
  It exits non-zero on any mismatch, then `await kit.stop()` and `await fake.stop()`.
- **Run and capture.** `feature=herdr-session-reread; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-session-reread.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **session-reread shows.** The session is absent after the detection and present after the status push, with the status `working`.

## Gotchas

- The session is set on the fake's row with no event, so only the kit's own re-read can bring it in: a pass proves the re-read, not a push.
- Before the change the status push never re-reads, so `agentSession` stays undefined and the drive times out.
- `await kit.stop()`; adopt mode never stops the stand-in server, so also `await fake.stop()`.
