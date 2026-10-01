# Complete run text: truncation reconciliation

Reconciled on 2026-10-01 against origin/main `5efd65cc` and unpacked npm
`@byokit/openclaw@0.4.0`. Both still select `agent.wait.terminalReply.text`
ahead of complete assistant text. No duplicate fix was present.

## Established real API output

The existing real-host capture used kit 0.3.4 and engine 2026.8.1. It is
reused here without another provider generation or any consumer/parser edit.
The diagnostic observed the ordinary kit request, callback and result boundary:

| Boundary | Characters | Valid JSON |
| --- | ---: | --- |
| Last complete assistant callback | 27,943 | yes |
| `agent` final `result.payloads[0].text` | 27,943 | yes |
| `agent.wait.terminalReply.text` | 4,089 | no |
| Kit final callback and successful `RunEnd.text` | 4,089 | no |

Source: firstmate's existing `v1-pm-2/evidence/localhost-real-kit-api-gap.txt`
and `localhost-real-kit-boundary-summary.json` (the latter's SHA-256:
`3a38ce2ffd8d9167498f16b27dc08db122eebb8981099a2c3921939c11bdf9b5`). This is historical real API output evidence, not a live
qualification of this patch. The same capture reports successful dispatch and
usage; its quota window is metadata, not a quota failure.

The unpacked engine pin's `openclaw-state-db-Cb4e1jdd.js:2384` sets
`AGENT_RUN_TERMINAL_REPLY_MAX_CHARS = 4096`. Its snapshot sanitizer strips
metadata, trims, and truncates with an ellipsis. It also distinguishes `visible`,
`silent` and `empty`. The engine snapshot is bounded lifecycle/display evidence.
The first loss of completeness is that sanitizer; the kit's unconditional
snapshot precedence then replaces still-complete generated text at finalization.
Long generated output triggers the loss, snapshot precedence exposes it, and
invalid consumer JSON is the symptom. Omitting the snapshot masks the defect by
restoring the existing stream fallback; changing JSON parsing cannot repair it.

## Synthetic replay through unchanged code and counterfactual

A no-network/no-provider replay imports each real `createRuns` implementation,
supplies valid 27,943-character JSON as both stream and final payload, and supplies
a 4,096-character capped terminal snapshot. Only snapshot presence changes:

| Implementation | Snapshot present | Returned characters | Complete |
| --- | --- | ---: | --- |
| Unchanged main | yes | 4,096 | no |
| Unchanged main | no | 27,943 | yes |
| Unpacked npm 0.4.0 | yes | 4,096 | no |
| Unpacked npm 0.4.0 | no | 27,943 | yes |
| Patched source | yes | 27,943 | yes |
| Patched source | no | 27,943 | yes |

These are synthetic packet replays, not real generated output. The regression
in `packages/openclaw/test/runs.test.ts` retains this packet boundary and verifies
final-payload authority over complete/partial/missing streams, final callback and
schema-result coherence, ordered payload text, explicit empty strings, stream and
terminal fallbacks, silent/empty dispositions, delayed/rejected final frames,
and abort/error outcomes. Existing tests retain member/model/tool boundaries.

The binding selection rule is in `docs/runtime-kits.md` section 5.8. Public types
and request count remain unchanged. The existing five-second final-frame grace
bounds finalization; when the frame is unavailable, stream then terminal text
remain fallbacks. If both complete sources are unavailable, the kit cannot
reconstruct output absent from the gateway. No engine lifecycle or paid calls
were used to qualify this patch.

## Release handoff

0.4.0 remains affected. This lane does not publish or change the package version;
the supervisor coordinates the patch release from merged main. Consumers must
verify that release's exact version and the following note before resuming:

- FIX: Successful runs preserve complete generated text in the final callback and result instead of replacing it with a capped terminal snapshot; silent and empty replies remain empty.
