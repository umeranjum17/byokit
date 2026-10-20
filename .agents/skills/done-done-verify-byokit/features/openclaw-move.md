# OpenClaw move

Verification recipe for [moving a conversation](../../../../docs/runtime-kits.md#515-accounts-one-shared-grant-one-view-per-account-d17) (O14 step S12): `kit.move({ member, sessionKey }, to)` carries a conversation to another account with its whole transcript.

## Sub-features

- Cross-agent move: one `sessions.create { agentId: <target>, key: 'agent:<target>:<tail>', parentSessionKey, fork: true, model }` (never `chat.history` plus `chat.inject`), then `sessions.delete { deleteTranscript: true, expectedSessionId, expectedSessionUpdatedAt }`; answers `{ ok: true, session: 'agent:<target>:<tail>' }`.
- The target holds the user, tool call, tool result and reply rows; the source session is gone; the next run on the app key continues on the target.
- `busy` while a run is live on the conversation; `close_failed` with `live` = the new key when the delete is refused (both kept); `unsupported` for a conversation never started; `start_failed` when the target is not signed in (nothing forked); another member's key is refused.
- A move within one agent (two member-agent accounts) forks nothing and answers its own key.
- A session already under the target key refuses the move (`start_failed`, `move.taken`). A run that waited for its agent's lock across a move ends `run.moved` before any event; its retry lands on the target (`packages/openclaw/test/accounts.test.ts`, `move: a run that waited across a move`).

## How to get to it (user POV)

A person whose chat runs on their Work ChatGPT account chooses "Move to Personal". The chat keeps every earlier message, including what the tools did, and the next reply comes from Personal.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-move.mjs` from the worktree root:

```bash
feature=openclaw-move
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-move.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. The consumer imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries and prints the source and target rows, the engine requests the move sent, the next run's account event and each refusal; it ends `MOVE OK`.

## Gotchas

The fake gateway stands in for the engine's transcript store: its `sessions.create { fork }` copies the parent's rows as the pin does across agents. The real pinned engine's fork (the model sees the earlier user turn and the tool call and result on the target, billed on the target's key) is proved by `move` in `packages/openclaw/test/engine/accounts.test.ts` (`npm run test:engine`). No provider, credential or network is involved.
