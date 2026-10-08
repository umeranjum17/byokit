# OpenClaw accepted/thinking progress and ready-run admission

Build and doctor as in the parent skill. This is a plain consumer of the built public package, driven through the real pinned Gateway. It installs only the kit's pinned engine into an explicit task-private root. A task-owned offline Claude CLI protocol stand-in reports local sign-in status and emits a real native stream record containing `estimated_tokens: 23`; the stock engine produces `thinking { progressTokens: 23 }`. No provider, personal credential, browser sign-in or spend is used.

```bash
feature=openclaw-run-progress
entry=.agents/skills/verify-byokit/capture/openclaw-run-progress.mjs
drive=(node "$entry" "$HOME/.cache/fm-scratch/openclaw-run-progress" --expect-progress)
```

Use the parent skill's Evidence block (or the task's authorized external evidence directory). The drive prints timestamped send/first-event/answer timelines for a prepared engine and a warm turn, raw engine thinking and forwarded events, plus actual native auth-probe counts. It requires exactly one `started` before progress, actual `thinking.tokens === 23`, the complete answer, and no extra native auth probe on prepared/warm admission. It changes the stand-in's app-owned credential-state file and requires an honest `signed-out` end **without** accepted/progress events. Run without `--expect-progress` on the built baseline to retain the before timeline. Both modes assert the engine actually produced thinking, not merely a fake transport event.

The run closes its kit and deletes only its own state directory; remove the supplied exclusive scratch root after the before/after pair (it holds engine sets). This is SDK behavior, not a changed UI: no screenshot is applicable. This proof does not claim remote provider revocation detection; local readiness cannot prove that. The existing kit journey in `packages/openclaw/test/kit.test.ts` covers reported expiry, the bounded lifetime, external file changes, cross-member refusal, auth mutations, genuine engine signed-out errors, disconnect and restart. Existing API-key journeys cover key replacement/logout isolation; `packages/openclaw/test/runs.test.ts` covers accepted/thinking/tool/text order, unrelated/malformed progress, native start deduplication, cancellation and errors.

For the intentionally slow gateway-boundary counterfactual, retain a built public consumer with `fakeGateway` and a 4700ms `models.authStatus` response under the private task evidence folder. Label this a stand-in, separately from the real-engine native timeline: it proves removed serialized checks, not the upstream route's real latency.
