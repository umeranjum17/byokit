# R1 real-engine recovery ownership reproduction

Status: **REPRODUCED; accepted R1 prefix opt-out implemented through S1's immutable-set seam. Owned early/late real-engine acceptance passes. Remaining controls/gates are pending; no consumer or publication acceptance claimed.**

## Candidate and isolation

BYOKit HEAD and local `origin/main` were both `a83760844c6d83151be996771f73584f8015dce6` on entry (unpublished OpenClaw kit 0.5.1 source candidate, sign-in restart fix included; public 0.5.0 lacks it and no successful publish PUT was proven). Disposable branch `fm/byk-oc-resume-owner`; no consumer worktree, account, auth copy, live provider, or external engine call. Engine: stock npm **openclaw 2026.8.1**, installed with the kit's unchanged engine manifest/lock. Node **24.21.0**. Dependency installs and all engine probes held Root `state/heavy-jobs.lock` on fd9 for their entire lifetime.

`packages/openclaw/test/engine/recovery-probe.ts` uses the actual public `OpenClawKit`, real Gateway RPCs, real tool bridge, real SQLite sessions/transcripts and task-owned provider HTTP server. A task enters the host `note` tool; only then the harness SIGKILLs its own kit caller and identity-verified Gateway. It starts a new caller on the identical stateDir/sessionKey. Gateway subprocess env gets the existing no-network test guard through a fixture-only `doctorContext` extension, not an engine source change. All engine homes, locks, sockets, identities, config and workspaces are task-owned. Provider keys are dummy fixture strings.

Reproduce (hold the home heavy lock externally):

```sh
PATH=/home/umer/.local/share/mise/installs/node/24.21.0/bin:$PATH \
TMPDIR="$PWD/.tmp/r1" HOME="$PWD/.tmp/r1/home" \
NODE_OPTIONS="--require $PWD/scripts/test-egress-guard.cjs" \
R1_OUT="$PWD/.tmp/r1/fresh" \
node packages/openclaw/test/engine/recovery-probe.ts
```

Use a fresh R1_OUT on every run. Install repository deps with `npm ci`, engine with `npm ci --ignore-scripts --prefix packages/openclaw/engine` under the same lock first.

## Results (v3)

Each case has an isolated Gateway; all provider calls in that row belong to the stated full session key. Engine prompt sanitation abbreviates `R1_KEY` in subsequent request bodies, so the harness's row key, not a regex of sanitized model text, is authoritative.

| Case/key | Provider requests | Engine recovery requests | App continuation | Transcript denial | Final engine session |
|---|---:|---:|---|---|---|
| late / `agent:m1:crewhouse:bot:late` | 5 = initial 1 + engine 2 + app 2 | 2 | succeeds after engine recovery | `unknown run` on replay-safe `read` | done |
| early / `agent:m1:crewhouse:bot:early` | 3 = initial 1 + engine 2 | 2 | fails `Session ... changed while starting work. Retry.` | `unknown run` | done by engine; app did **not** complete |
| normal / `agent:m1:crewhouse:bot:normal` | 2, no restart continuation | 0 | completed before clean stop/restart | none | done |
| excluded / `agent:m1:cron:r1` | 3 = initial 1 + app 2 | 0 | succeeds after identical crash/restart | none | done |

The **late** case proves two post-crash model continuations of the same interrupted key, not just stock synthetic recovery alone. Distinct actual transcript run ids: initial `f9101184-64fa-423d-bf94-5be6128451b9`, engine recovery `7bb8eece-d22a-4315-8045-d47efb8eaee1`, app continuation `6f86e4bb-0ef3-4e99-a1cd-26405a1a25ca`.

Exact UTC transcript sequence:
- 06:58:40.968: initial assistant calls `note`; host call entered, then both owners killed.
- 06:58:47.988: engine inserts internal-system user exchange, provenance `sourceTool: main_session_restart_recovery`.
- 06:58:51.065: engine recovery `read` toolResult: `unknown run`, `details.status=blocked`, `deniedReason=plugin-before-tool-call`.
- 06:58:51.090: recovery assistant finishes.
- 06:58:59.920: new caller appends its own continuation on the **same sessionId**.
- 06:58:59.956: app `note` returns `task note done`; app finishes `ok:true`, text `app task done`; session entry status done.

The **early** case proves a competing app admission while the recovery response is in flight: recovery provider request at 06:59:28.514, kit ready at 06:59:29.977, app admission rejected at 06:59:30.069, recovery completes at 06:59:31.585. It does **not** prove simultaneous admitted model execution; stock session gates prevented that. Do not describe serial double continuation as two simultaneous model calls.

## Trigger vs masks vs symptom

**Trigger:** interrupted public-kit app session remains `status=running`; `markStartupOrphanedMainSessionsForRecovery` discovers it at startup, and `isMainRestartRecoveryCandidate` excludes subagent/cron/ACP ownership only. Custom `agent:m1:crewhouse:...` qualifies despite being app-owned. Startup scanner claims and dispatches recovery without a kit registration. Kit registration exists only during `createRuns.run` and is indexed by session key; it does not assert durable recovery ownership before engine startup.

**Smallest causal counterfactual measured:** same real interruption and caller resume with stock-recognized cron key. No marker deletion, session/history reset, gate bypass, source patch or tool/refusal filter. Engine recovery disappears; app completes with only two continuation provider calls. This isolates candidate eligibility, but a cron key is **not an honest product fix** for an app task: it misclassifies ownership.

**Timing mask:** v2 immediate app continuation won the foreground race (3 total calls, no recovery); v3 same early path lost and returned admission error. Fast caller resume is not a durable guarantee.

**Safety/availability masks:** original general contract stub repeated an app-only `note` script through recovery although stock recovery removes `note` from its safe tool set, inflating totals to 14 per crash case. That is preserved diagnostic evidence, **not a cost estimate**. v2 valid offered `read` was denied as `can't check this action right now` because recovery reached its tool before the kit bridge was ready. v3 uses ordinary three-second scripted provider latency: bridge reconnects before `read`, exposing exact `unknown run`. Neither denial means the extra model turn was prevented. A refused tool may still be followed by a provider response; scripted final text is not proof of a real external action.

**Symptoms:** unbudgeted recovery model turn; synthetic transcript exchange and denied tool result; duplicate serial continuation or app admission conflict. Stock policy prevented unregistered external action; it did not ensure a single continuation owner.

## Seam recommendation, not implementation

No supported config/session opt-out found in the pinned candidate function or startup dispatcher. Do **not** rename tasks to cron/subagent, clear hidden recovery markers, delete histories or weaken the bridge. A source-owned per-session/app ownership selector checked by the shared candidate function is the smallest causal engine seam; default must remain stock. It must reach durable session registration **before** restart scanning, and preserve lifecycle accounting, cancellation, retry charges/tombstones, files and policy gates. Root must commission the maintained reproducible bundled-engine foundation/packaging before worker source patching. No raw download-tree edits, private consumer install or upstream release dependency.

Pending-request boundary for the browser handoff scout: app same-session continuation is a new foreground run, not attachment to/reconstitution of the crashed host's in-memory gate or pending tool promise. The initial `note` outcome remains unknown; engine marks synthetic recovery independently. An app pending request needs its own durable identity and caller policy; this harness implements no broker/scheduler.

## Acceptance and limitations

R1 **currently fails** exactly-one continuation and no-unknown-denial conditions in late case; early case also fails app-done. No fixed-candidate acceptance claimed. Final current-fixture confirmation passed all six stock-behavior assertions. Cancellation at the actually entered host tool returns `{ok:false, aborted:true}`, persists `status=killed`, and makes no recovery provider request after clean restart. **Started-turn repeated crashes do not tombstone at three**: after three identity-verified recovery crashes, the fourth startup dispatches a fourth provider request; `chargedAttempts=4`, `startedAttempt=4`, status running, no tombstone. No task done claimed for that deliberately interrupted case. Actual Crewhouse `crewd`, SQLite task scheduler and consumer task `done` were **not run**: this home's authority excludes consumer processes and writes. This is a faithful public-kit caller reproduction, not equivalent Crewhouse integration acceptance; main owns that adoption/qualification.

## Evidence and provenance

Raw receipts/logs are retained under task `.tmp/r1/{probe,v2,v3}` and copied to Root `data/byk-oc-resume-owner`. The original four-case counts, v2 boot-timeout receipt/log and v3 successful receipt are preserved separately. v2 timeout was a harness 60s readiness deadline, not recovery acceptance failure; its unready task-owned leftover Gateway was explicitly verified/stopped, and v3 extended readiness to 180s.

SHA-256:
- kit engine lock `c9e6ae35598cd54cabd6b1ea0cde6f826cef7b8082b1a0d67000e2373df07b9b`
- stock `main-session-recovery-state-BWIrIyi_.js` `418a957496786dd7ed28df4a7a02e31e9567020e1be5804545e785baf965f225`
- stock `main-session-restart-recovery-marking-CoJAH67Z.js` `315bf8ae5a7c2146218f72c0f7a961a961fa46c341bccdbc37a4544980e17634`
- stock `main-session-restart-recovery-tKcU544C.js` `65311491eb5a3a9fa52511b96305b5103149987c19e8005cb3eb1d8fce2f4b76`
- v3 raw receipt `f03b3a6b42449a98f04ad987c263f4a5ed997b622d88cb6c793c47067dc36836`

## Final current-fixture qualification and stock-budget correction

Final six-case log is `final-proof.log`; complete raw provider bodies, SQLite transcript/entry snapshots and caller events are in Root `final-receipt.json` / `final-provider-requests.json`. Exact executed fixture is Root `executed-source.ts`; hashes in `sha256.txt`. Final short task-owned scratch was `/home/umer/.bkt/r1.BqxxK1`; no consumers or shared processes were driven.

The conditional three-attempt statement in the report needs correction: stock `getMainSessionRecoveryRetryCount(state)` is **chargedAttempts minus startedAttempt**. A recovery that actually starts sets startedAttempt to its attempt number. Three admitted/started model turns killed during provider work therefore do not consume three consecutive pre-start failures: the fourth starts. Measured snapshots before each crash had chargedAttempts 1/2/3; fourth had 4/4, no tombstone. The separate three-**pre-start failure** tombstone route has not been exercised here. Preserve this stock accounting unless separately commissioned; no general retry cap is being invented.

The first repeat probe failed its incorrect unconditional `no fourth recovery request` assertion; `probe-v5.log` and `v5-repeat-sqlite.log` preserve it. Source analysis and v6/final real execution confirm the correction. V4's shell timeout included heavy-lock queue time, interrupted cancellation qualification, and left one identity-verified task Gateway; it was stopped under reacquired fd9, not by a command-name kill. No pass claimed for v4.

Workspace `npm run build` and `npm run check` passed. First source-only check failed on stale workspace dist exports; required build resolved it. Full `npm test` with repo-local TMPDIR was **Root-stopped, exit143, not passed**: fake CLI was inside repo type=module (`require` undefined), and egress AF_UNIX socket path exceeded its limit (`listen EINVAL`). Root retained exact process/stop receipts under `root-stopped-gate`. A motivated focused rerun with authorized short external TMPDIR exercised those failing CLI/egress tests plus every OpenClaw unit test: **283 passed, 0 failed, 0 skipped**, real Pi bytes unchanged. No unrelated full-suite rerun or policy/source repair.

The preceding sections describe the preserved stock baseline. Subsequent conditional implementation is below; no stock installed CLI was changed.

## Conditional implementation and current fixed-candidate evidence

Root accepted the scoped ownership opt-out and commissioned S1. This lane integrated S1 contract `2d9f63e66c93e287624898a78692c80d9fdb47fc` and immutable applier `11a4738153fe55c3cb227353cd826803bf967f89`; local cherry-picks are `305c9e22` and `87809833`. The existing sign-in inventory assertion was retained when resolving the applier test conflict; no unrelated route expansion was invented.

Binding 5.16 names are used: `KitOptions.appOwnedSessions?: { keyPrefixes: string[] }` and isolated `BYOKIT_APP_OWNED_SESSION_PREFIXES`. Prefixes begin `agent:<id>:` and cannot cover that agent's main key. Public member prefixes are expanded to their isolated API-key agent keys; future sign-in namespaces are ordinary prefixes too. Invalid public options fail before preparation; malformed raw engine env falls back to stock empty prefixes. Prefix arrays are copied. Only the shared candidate predicate is changed: no cap, cron scheduler, tool filter, marker deletion, session rotation or new installer.

Manifest ID `9be16913c7858ec9`; one file, unchanged stock SHA `418a957496786dd7ed28df4a7a02e31e9567020e1be5804545e785baf965f225`, patched SHA `f1afea642c78d7979ed40ce43c102c41f790c5dbedaec0e6e7eb8d6f47bc0032`. The S1 generator `--check` passed. Source typed-option tests passed with the binding names.

Real owned early/late execution (`aligned-proof.log`, full receipt copied to Root): both **3 provider requests per key** = initial interrupted request + **one** app continuation with tool/result provider requests. Both return `{ok:true,text:'app task done'}`, session status done and unchanged sessionId. Both have **0 engine recovery requests, 0 synthetic recovery exchanges and 0 unknown-run denials**. Every ready receipt identifies adopted patchSet `9be16913c7858ec9` and the immutable engine entry under `engine.sets/1f1aec5d54639b25-9be16913c7858ec9/`. The original `engine/node_modules` stock bytes remain untouched. This is public-kit caller acceptance, **not actual Crewhouse scheduler acceptance**.

The first opt-out attempt had a 180s harness readiness deadline during initial immutable-set preparation (npm itself exited0); it never reached a Gateway or policy acceptance. Exact failed proof/install log is retained. A setup-aware bounded 900s readiness allowed the real aligned proof to complete. No private mutable engine or alternate installer was used.

The first subsequent control gate ended **exit143 before any case log/path was generated**. Root confirms it did not stop that gate; signal sender/parent cause was not captured and remains unknown. Do not attribute it to Root or an engine crash. The corrected gate recorded queue/PID/PPID/acquisition and per-case boundaries: **1795 seconds queued**, then all seven controls exited0 with separate 360s deadlines; shell exit0. Exact receipt: `pending-control-gate.log`.

| Fixed-candidate control | Requests | Engine requests | Result |
|---|---:|---:|---|
| owned cancellation | 1 | 0 | aborted true, status killed, no unknown denial |
| owned repeated interrupted app attempts | 6 | 0 | initial + three interrupted app requests + final two-request continuation; done, no synthetic/unknown denial |
| opted kit, nonmatching `agent:m1:other:outside` | 5 | 2 | stock synthetic recovery and unknown denial retained; app then done |
| stock normal completed restart | 2 | 0 | done, no extra turn |
| stock delayed app resume | 5 | 2 | original double-continuation/unknown denial retained |
| stock started recovery crashed three times | 5 | 4 | chargedAttempts=startedAttempt=4, running, no tombstone; stock accounting unchanged |
| malformed raw ownership env | 5 | 2 | falls back to stock recovery and unknown denial |

Source build and check passed post-integration. Unit qualification exposed four S1 fake-install failures because its empty-manifest fixtures seeded no pinned module bytes for the first production semantic entry. A licensed exact 24KB stock byte fixture, checked against `before`, repaired three: **12/13 pass**. The remaining unit test expects fresh npm installation after damaging a patched set, but the now-nonempty manifest correctly retains a verified stock set and rebuilds the patched set offline; `npm-calls` is absent, producing ENOENT at the old assertion. This is a fixture expectation/stock-cache setup issue, not a demonstrated product policy failure. It recurred in the same immutable-install case, so escalation follows the worker's two-obstacle rule; no applier/installer rewrite or further speculative test mutation.

The motivated full offline delivery gate stops at that remaining unit failure; it has not run to completion. The earlier Root-stopped full suite remains **not passed**. Actual consumer `crewd`, packed-kit qualification and final delivery gates are still unclaimed. Source and all raw failures are retained; no push/PR/publication has occurred.
