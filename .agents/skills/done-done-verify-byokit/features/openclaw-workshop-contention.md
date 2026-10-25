# OpenClaw Workshop apply beside a second writer

Verification recipe for the shipped lease-wait edit in [the pinned engine's patches](../../../../packages/openclaw/engine/patches.json): a Workshop proposal applies while another connection holds the shared state database's write lock longer than the engine's 5 s SQLite busy timeout. Before that edit the same drive failed with `database is locked` / `OPENCLAW_STATE_LEASE_STORAGE_FAILED`.

## Sub-features

- One install, two writers: the pinned engine's Workshop apply takes `skill-collection` and `skill-workshop-target` state leases in the shared `<stateDir>/openclaw/state/state/openclaw.sqlite` (WAL), so any other writer on that file is in the apply's path.
- The lease worker's own attempt transaction waits up to 30 s for that writer (patch set `9c808389825f4e85`, one call-site constant in the lease worker chunk); the engine-wide 5 s constant and every schema, RPC, config and retry-loop behaviour stay as the engine ships them.
- What a user sees: the apply lands `applied` and reads `applied` afterwards, having waited out the other writer, instead of failing the run with a non-retryable `INVALID_REQUEST`.

## How to get to it (user POV)

Link a member, write a Workshop proposal (create, then inspect), keep something else writing the same state database for several seconds and apply — as `apps` do when two features of one install touch the engine at once.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-workshop-contention.mjs` from the worktree root, with the pinned engine installed on disk (`BYOKIT_VERIFY_ENGINE_DIR`, default `~/.cache/byokit-done-done-engine`):

```bash
feature=openclaw-workshop-contention
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-workshop-contention.mjs
drive=(node "$entry" "$evidence_dir")
```

Use SKILL.md's Evidence capture block after allocating `evidence_dir`. The consumer boots the built public `@byokit/openclaw` kit on the real pinned Gateway, records the engine version and the running engine's patch set, takes a `BEGIN IMMEDIATE` write lock on the shared state database from a second connection and holds it 8 s (`BYOKIT_CONTENTION_HOLD_MS`), then applies the proposal and asserts it waited past the busy timeout and landed. The scratch state dir is removed in `finally`; no provider, credential, model or network is involved.

## Gotchas

The regression for it is `packages/openclaw/test/engine/sqlite-contention.test.ts` (CI shard `generated-learning-migrate`), which fails on the stock engine set and passes on this one; this drive proves the same behaviour through the built public entry on a real boot. A hold shorter than the engine's 5 s busy timeout proves nothing — that is the contention the engine already rides out. The drop condition is upstream retrying `SQLITE_BUSY` in its lease acquisition loop instead of reporting `store-unavailable`. There is no changed app screen, theme or device UI.
