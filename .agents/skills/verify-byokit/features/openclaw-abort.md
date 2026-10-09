# OpenClaw cancellation after engine loss

This journey verifies the [OpenClaw cancellation usage contract](../../../../packages/openclaw/README.md#quickstart) through a healthy held run, an engine drop and an already-gone engine, using the public built kit.

## Sub-features

- Healthy held turn: `abort` reaches the real engine and the run ends `{ ok: false, aborted: true }`.
- Engine killed during a held turn: `abort(...).catch(...)` receives `gateway not ready`; the lost run retains its failure, not an aborted receipt.
- Engine already gone: the same catchable error without a synchronous throw.
- Invalid API-key session: the public facade rejects key mapping without throwing synchronously.
- No `unhandledRejection` in the catch/await consumer journey; callers must still handle rejected Promises.

## How to get to it (user POV)

Start a kit, start a task, then cancel it. If the engine disappears first, the app's existing Promise error handler can report that cancellation could not reach the engine rather than crash before the handler attaches.

## Driving it with node scratch consumers

Build and doctor per SKILL.md. The maintained consumer imports only public built entries and runs the pinned engine with the existing loopback scripted provider, not a fake Gateway. On Linux:

```bash
feature=openclaw-abort
entry=capture/openclaw-abort.mjs
# Absolute, exclusive worktree path for engine ownership checks; avoid RAM-backed /tmp.
scratch_dir=$(mktemp -d "$PWD/scratch.verify-byokit.XXXXXX") || exit 1
export ABORT_SCRATCH="$scratch_dir"
drive=(node .agents/skills/verify-byokit/capture/openclaw-abort.mjs)
```

Run the SKILL.md Evidence block under the host's heavy-job lock and memory gate. An explicitly assigned private evidence folder may replace the default folder. Output includes the engine pin and built entry, each abort's synchronous exception/rejection, both run outcomes, and the unhandled-rejection count. Exit 0 requires every control. Retain the command and transcript before removing only `$scratch_dir`.

Existing engine integration coverage: `BYOKIT_TEST_ENGINE_DIR="$scratch_dir/engine" sh scripts/test.sh --test-name-pattern='abort stays catchable' packages/openclaw/test/engine/run.test.ts` (reuse the task's verified installed pin; no second bulky install into the runner's temporary HOME). This test extends the existing real-engine run journey; it is not a substitute for the public built consumer.

## Gotchas

- The first run installs the pinned engine; allow package-install network, never provider sign-ins or real provider requests. Engine/model runtime uses the loopback stub only.
- The drop is SIGKILL only after verifying the task-owned engine's PID, start time, and state directory in `/proc`. Linux required; do not use an unrelated PID.
- `kit.stop()` prevents automatic recovery before the already-gone control. Engine loss alone is not evidence that cancellation reached the engine.
- Promise rejections still need await/catch; intentionally discarded Promises are not claimed safe.
- No UI changed; no screenshots or live-provider claims. This proof does not qualify reconnect/restart behavior.
