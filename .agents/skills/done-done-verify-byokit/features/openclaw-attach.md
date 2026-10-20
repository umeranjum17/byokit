# OpenClaw live run attachment

Build and doctor as in the parent skill. The engine integration journey is also a built public-entry consumer: it imports only published kit entries for all runtime behavior. The engine, model stub and encrypted loopback pair remain real, task-owned paths, not a fake Gateway. No account, credential, UI, browser or screenshot applies.

```bash
feature=openclaw-attach
entry=packages/openclaw/test/engine/attach.test.ts
drive=(sh scripts/test.sh "$entry")
```

Run with the parent Evidence capture block (or the task's authorized external evidence folder), under the heavy-job lock and memory gate. Set `BYOKIT_TEST_ENGINE_DIR` to this task's on-disk engine root to reuse the pinned install; never use an owner's app engine or credentials. Without it, the runner creates and cleans a private engine set.

The journey starts `oc.run` with an explicit stable idempotency key, terminates the actual phone WebSocket after seq 1, waits for real tool events during the drop, reconnects the same grant, then attaches with `fromSeq=1`. It requires replayed tool events before releasing the held model completion, contiguous combined seqs 1..N, byte-equivalent terminal frame to an unbroken run, no duplicate completed replay, a second member's `link.notAllowed`, malformed cursor refusal, and typed unknown-run refusal. Eighteen real tool calls overflow the 32-frame buffer: an old cursor must receive typed truncation and the exact boundary must replay all 32 retained frames. Stopping the engine must make old runs typed not-found. The JSON receipt prints sequence numbers, terminal frame, truncation boundary and cross-member result.

Engine integration acceptance: `sh scripts/test.sh packages/openclaw/test/engine/attach.test.ts`; included automatically in `npm run test:engine`. Engine-restart history reconstruction is deliberately not claimed.
