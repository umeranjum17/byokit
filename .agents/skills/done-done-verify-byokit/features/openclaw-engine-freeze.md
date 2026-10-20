# OpenClaw engine-set freeze cost

Verification recipe for the engine-set freeze in [`@byokit/openclaw`](../../../../packages/openclaw/README.md)
(`prepareEngineSet`/`freeze`, 5.16). The durability rule is stated once, in [`docs/runtime-kits.md`](../../../../docs/runtime-kits.md) 5.16.

## Sub-features

- A clean first install (stock set + patched set) completes and both sets verify, with no per-entry fsync in `freeze` and at most one bulk flush.
- A drifted/damaged published set is still detected by full verification and rebuilt as a sibling; the old tree's
  bytes are preserved; the drifted set is never launched (covered by `packages/openclaw/test/engine-unit.test.ts`).
- Freeze wall time on a real engine set is seconds, not minutes. This is the author's measurement on the reference
  host, not something the repository verifies.

## How to drive it (real install, needs registry access)

From a built worktree, run a clean `Engine.prepare()` with an isolated stateDir/engineDir under a short scratch
path (Unix socket limits), through the home's memory gate, and time it. To split freeze wall time from total prepare,
use a `node:module` `registerHooks` probe wrapping `async function freeze(dir: string): Promise<TreeEntry[]> {` in
`packages/openclaw/src/engine-patches.ts`; the probe wraps the source form only. Offline, the whole journey (clone,
patch, freeze, publish, drift rebuild, fault refusal) is covered by the existing engine-patch tests; no new unit test
belongs here.

## Gotchas

- Real installs need network for `npm ci` (the engine CI job); everything else is offline by contract.
- Runs are heavy: one at a time, behind the home's heavy-jobs lock and memory gate.
- Sets are ~0.9 GB each and never garbage-collected: scratch roots must be deleted after measuring.
