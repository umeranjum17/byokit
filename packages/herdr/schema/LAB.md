# H9 lab contract run — @byokit/herdr against real Herdr v0.9.1

Run: 2026-09-29T06:34Z (lab file `packages/herdr/test/lab/contract.lab.ts`,
`node --test` with a task-owned HOME; not matched by `npm test`'s glob).
Result: **11 pass, 0 fail, 13 skipped** (every skip carries its reason below).

## Pinned release

- Version: **0.9.1** (`herdr --version` → `herdr 0.9.1`), protocol **22**.
- Asset (linux-x86_64):
  `https://github.com/herdrdev/herdr/releases/download/v0.9.1/herdr-linux-x86_64`
- Asset sha256: `2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7`
  (verified over the downloaded bytes before anything was started; matches
  `schema/SOURCE.md` and the release manifest).
- Snapshot sha256: `226d4ecbd128d2e6bc84e4c8ddcec21ba9c7e51a0aafffcf087111ead3f1fa9a`.
- Runner: `HerdrKit({ mode: 'own', bin, stateDir })` with `bin` the verified asset
  (absolute path) and a fresh `stateDir` per case under a task-owned temp dir.

## Isolation proof (before the kit started anything)

From the v0.9.1 binary itself, with the kit's own-mode env
(`HOME=<stateDir>/herdr/home`, `HERDR_SOCKET_PATH=<stateDir>/herdr/herdr.sock`):

- `status --json` reports `server.socket` = the task `herdr.sock`,
  `server.running: false`, `client.binary` = the task binary. The fleet server
  (`/home/umer/.config/herdr/herdr.sock`, running) is not visible through this env:
  `HERDR_SOCKET_PATH` relocates the API socket on v0.9.1.
- `session list --json` under the task HOME shows only a non-running `default`
  session whose `session_dir`/`socket_path` sit under the task HOME. State lives
  under the task HOME; the fleet's sessions are unreachable from this env.
- A fresh task server bootstraps an **empty** live tree while the fleet holds many
  workspaces (asserted in the run: `snapshot().workspaces` is `[]` at start).

The whole run sat inside Herdr lab sessions: provision recorded the running fleet
`default` session as the tripwire before any lab Herdr started (`fm-lab-byk-hd-lab-922247-9781`),
and teardown verified it identical afterwards; a second explicit provision/verify/teardown
cycle (`fm-lab-byk-hd-lab-3031438-133`) confirmed the outcome. The fleet `default`
session was running before and is unchanged after
(`socket_path: /home/umer/.config/herdr/herdr.sock`, `running: true` throughout).

## Contract cases (`src/testing/contract.ts` names verbatim)

| Case | Verdict | Reason / note |
|---|---|---|
| start reaches ready and ping speaks the pinned protocol | pass | Real: `ready`, `ping.protocol === 22`, `agentKinds()` lists `pi`, no `bash`. |
| a protocol mismatch reports needs-update | pass | Transport double (same as CI). |
| an event racing the bootstrap snapshot is applied after it, once | pass | Transport double (same as CI). |
| a rejected subscription surfaces once and is not retried | pass | Transport double (same as CI). Real rejects with `id: ""` too (probed raw: code `invalid_request`, message ``missing field `pane_id` ``); the kit keys rejection off the empty id, so the fake's `invalid_subscription` code is cosmetic only. |
| events reach a subscriber; unsubscribe stops them | skip | Needs the fake `emit` helper; the real server has no scripted event source. |
| the per-pane status watch keeps the tree and blocked list current | skip | Needs the fake `setStatus` helper; no signed-in agent CLI in the lab home. |
| startAgent returns fresh pane ids in every placement | skip | Needs a signed-in agent CLI. `agent start --help` possible-values and live `agentKinds()` have **no `bash` custom kind**, so no unsigned agent path exists. |
| prompt validates the receipt and appends the reply text | skip | Same as above. |
| a malformed prompt receipt fails | pass | Transport double (same as CI). |
| wait resolves on a matching status and honors its timeout | skip | Needs a live agent pane; no signed-in agent CLI in the lab home. |
| read unwraps result.read | pass (lab-adapted) | Real shell pane: `{ text, truncated }` shape holds for `recent`, `lines`, and `detection` sources. Observation: real returns `truncated: true` for a `lines` read where the fake says `false` (scrollback windowing, not a kit defect). |
| blocked answers refuse a stale revision and accept the current one | skip | Needs a live blocked agent; no signed-in agent CLI in the lab home. |
| close guards refuse widening and close exact | pass (lab-adapted) | Real: `pane-close-would-widen` / `tab-close-would-widen` refusals plus exact `closePane`/`closeTab`/`closeWorkspace`. The worktree-parent sub-check is skipped (needs a live agent placement). |
| the cli answers --version and the terminal echoes | pass (lab-adapted, split) | Real: `cli(['--version'])` → `herdr 0.9.1`, exit 0; `terminal observe` reaches ready and exits cleanly. The echo half is skipped (see below). |

Lab-only splits: `read unwraps result.read on a real shell pane`, `the worktree-parent
close guard` (skip), `the cli answers --version on the real binary`,
`terminal observe reaches ready and exits cleanly`, `terminal observe echoes sent input`
(skip: the fake shim echoes sends; the real server emits NDJSON `bytes` frames and no
echo — follow-up for the fake owner, no kit check loosened).

## H7 placeholders (repeat after H7 lands)

`hd.link round-trips member ops`, `hd.device client over the link`,
`sealed blocked-agent notices`, `hd.terminal stream over the link` — all skipped with
reason `awaits H7` (`src/link.ts`, `src/device.ts`, `src/notices.ts` are still H7 stubs
on main). Re-run this file after H7 merges; the skipped agent cases additionally need
a signed-in agent CLI in the lab home (the schema offers no unsigned kind).

## Fake/real disagreement fixed in this PR

Live frames on v0.9.1 use the underscore const in **both** envelope and payload
(probed raw: `pane_created`, `workspace_created`, `tab_created`), while subscription
kinds use dots. The kit matched dot spellings only, so no live `created`/`closed` /
status event ever updated the tree against real Herdr. Fixed without loosening any
kit check: `src/kit.ts` matches both spellings at the event boundary;
`src/testing/fake-herdr/server.ts` emits real-style underscore wire frames and accepts
both spellings in subscriptions; `src/testing/contract.ts` and `test/fake.test.ts`
assert the underscore wire spelling.

## Repeat

Provision a `--herdr-lab` session, then from the worktree with a task-owned HOME:

```
HOME=<task-home> node --test packages/herdr/test/lab/contract.lab.ts
```

Teardown must verify the fleet tripwire identical afterwards.
