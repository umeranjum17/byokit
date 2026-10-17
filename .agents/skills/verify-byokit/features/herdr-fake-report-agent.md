# Herdr fake report-agent and held agent.wait: a status set from another process

The kit's stand-in Herdr answers `pane.report_agent` and the `herdr pane report-agent` CLI verb, so
a status set from a child process (a muxr-style host, a test helper) reaches the kit's snapshot and
`onChange` within a second. A state outside the pinned schema's `PaneAgentState` (`idle`, `working`,
`blocked`, `unknown`), `failed` included, is refused. `fake.holdAgentWait()` holds `agent.wait`
answers until its release runs, the same shape as `holdSnapshot`.

## Sub-features

- `report-agent-cli`: `herdr pane report-agent --pane <id> --state working` from a child process exits
  `0`, and the snapshot shows `working` within 1 s.
- `report-agent-refused`: `--state failed` exits non-zero with `invalid_params` naming the four
  accepted states, and the status stays where it was.
- `report-agent-socket`: `kit.call('pane.report_agent', …)` sets the status and the blocked list
  picks it up.
- `agent-wait-hold`: a held `kit.wait` does not answer until the fake's release runs, then answers
  with the current status.

## How to get to it (user POV)

Adopt the stand-in: `startFakeHerdr` (`@byokit/herdr/testing`), then
`new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath })` and `await kit.start()`.
The fake's `w1:p2` is the agent pane.

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress.

- **Write the consumer.** `"$scratch_dir/verify-herdr-report-agent.mjs"` imports `HerdrKit` from
  `@byokit/herdr` and `startFakeHerdr` from `@byokit/herdr/testing`. It starts the fake and kit, then:
  runs `kit.cli(['pane','report-agent','--pane','w1:p2','--source','verify','--agent','pi','--state','working'])`
  and polls the snapshot for `working`; runs the same verb with `--state failed` and expects a
  non-zero exit with the `invalid_params` stderr and an unchanged status; calls
  `kit.call('pane.report_agent', { pane_id: 'w1:p2', agent: 'pi', source: 'verify', state: 'blocked' })`
  and polls for `blocked` and for `kit.blocked()` naming `w1:p2`; then holds `agent.wait` with
  `fake.holdAgentWait()`, starts `kit.wait({ paneId: 'w1:p2' }, { until: ['idle'], timeoutMs: 2000 })`,
  reports `idle` by the CLI, checks the wait has not answered after 300 ms, releases, and expects `idle`.
  It exits non-zero on any mismatch, then calls `kit.stop()` and `fake.stop()`.
- **Run and capture.** `feature=herdr-fake-report-agent; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-report-agent.mjs" "$scratch_dir")`;
  then run SKILL.md Evidence's capture block. Exit code `0`, last line `PASS: every check ok`.
- **report-agent-cli / socket show.** The snapshot status and the blocked list change from the
  outside process and the socket call alike.
- **report-agent-refused shows.** The CLI exits `1` and names the four accepted states; the status
  does not move.
- **agent-wait-hold shows.** The wait answers only after the release, with `idle`.

The same journey runs as contract cases in `packages/herdr/src/testing/contract.ts`
(`contract: pane.report_agent …`, `contract: pane report-agent from a child process …`,
`contract: a held agent.wait answers only after release`) in `npm test`.

## Gotchas

- The fake accepts `--pane <id>` (the form this recipe and the contract use) and the positional
  pane the real CLI takes in the evidence logs; the real verb also needs `--source` and `--agent`.
  Pass them both, as this recipe does.
- `kit.blocked()` fills after the status event lands: poll it, never read it synchronously after
  the report.
