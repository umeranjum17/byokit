# OpenClaw first start that misses its handshake

Verification recipe for [OpenClaw's engine lifecycle](../../../../docs/runtime-kits.md#54-lifecycle-and-supervision-srcenginets): a first `start()` whose gateway handshake times out, or whose engine exits before hello, retries inside the kit on the reconnect backoff, reaches `ready` when a later attempt is answered, fails as `handshake` after five missed attempts of that call, and stops retrying on `stop()`.

## Sub-features

- A missed first hello moves the state to `restarting` with `retryAt`, then `ready` on the next attempt; `start()` resolves at `ready` with no second app call.
- Five consecutive missed hellos end at `{ phase: 'failed', why: 'handshake' }` and `start()` rejects with `gateway handshake timed out`.
- `stop()` during the backoff cancels the wait: no further attempt, and `start()` rejects.
- Each `start()` call has its own five attempts, and an engine exit before hello is one missed attempt on one backoff. These run as kit tests (`packages/openclaw/test/kit.test.ts`, and `engine-unit.test.ts` with a seeded fake engine), not as legs here: the engine-exit case needs a spawned fake engine set, which the public entry cannot seed.

## How to get to it (user POV)

A host on a loaded machine calls `kit.start()` once. The first engine handshake misses its 90 s deadline (`KitOptions.handshakeMs` in tests); the kit waits out the backoff and tries again instead of stopping at "Needs a sign-in".

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-first-start-retry.mjs` from the worktree root. It needs an absolute scratch root that keeps Unix socket paths (`<root>/<name>/k-*/openclaw/bridge.sock`) under the host limit, so keep it short:

```bash
feature=openclaw-first-start-retry
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-first-start-retry.mjs
mkdir -p "$HOME/.cache/fm-scratch/byk" && scratch_root="$HOME/.cache/fm-scratch/byk/f"
drive=(node "$entry" "$evidence_dir" "$scratch_root")
```

Use SKILL.md's Evidence capture block after allocating `evidence_dir`. The three legs use the supplied `fakeGateway` transport with `spawnEngine: false`: no engine install, no network, no account. Expected: the retry leg prints `phases` `starting, stopped, restarting retryAt=number, starting, ready`; the cap leg prints `attempts: 5` and `failed`/`handshake`; the stop leg prints `attempts: 1`; the last line is `PASS`. The `stopped` phase in the retry leg is the engine stop that runs before each retry; the words table shows nothing for it.

## Gotchas

The handshake deadline is unref'd, so a bare script whose only pending work is a never-answering hello exits before the deadline; the consumer holds its own timer for that reason. The real pinned engine's handshake is not driven here: the transport is not a public entry, so a live engine cannot be made to miss its first hello without a test seam. The spawned-engine legs of `openclaw-auth-recovery` cover that the real engine still reaches `ready` through the same `start()`.
