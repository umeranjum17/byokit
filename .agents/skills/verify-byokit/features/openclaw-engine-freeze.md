# OpenClaw engine-set freeze cost

Verification recipe for the engine-set freeze in [`@byokit/openclaw`](../../../../packages/openclaw/README.md)
(`prepareEngineSet`/`freeze`, 5.16): a first install chmods ~38,000 entries read-only, flushes once (Linux syncfs)
and publishes the set with a manifest derived from the verified stock tree; per-entry fsyncs and duplicate
cold re-reads are intentionally not taken — crash safety is `verifyEngineSet`'s whole-tree content check at
every reuse/launch (a set torn by power loss mismatches `.byokit-tree` and rebuilds as drift, never launches).

## Sub-features

- A clean first install (stock set + patched set) completes and both sets verify, with no per-entry fsync in `freeze` and one bulk flush.
- A drifted/damaged published set is still detected by full verification and rebuilt as a sibling; the old tree's
  bytes are preserved; the drifted set is never launched (covered by `packages/openclaw/test/engine-unit.test.ts`).
- Freeze wall time on a real engine set is seconds, not minutes (chmod pass + one syncfs; the manifest is derived, not re-read).

## How to drive it (real install, needs registry access)

From a built worktree, run a clean `Engine.prepare()` with an isolated stateDir/engineDir under a short scratch
path (Unix socket limits), through the home's memory gate, and time it. The task's evidence
(`data/byk-install-freeze-cheap/evidence/measure-*.log` in the dispatching home) used a `node:module`
`registerHooks` probe wrapping `async function freeze(dir: string): Promise<void> {` in
`packages/openclaw/src/engine-patches.ts` to split freeze wall time from total prepare; the same anchor works
against the built `dist/engine-patches.js`. Offline, the whole journey (clone, patch, freeze, publish, drift
rebuild, fault refusal) is covered by the existing engine-patch tests; no new unit test belongs here.

## Gotchas

- Real installs need network for `npm ci` (the engine CI job); everything else is offline by contract.
- Runs are heavy: one at a time, behind the home's heavy-jobs lock and memory gate.
- Sets are ~0.9 GB each and never garbage-collected: scratch roots must be deleted after measuring.
