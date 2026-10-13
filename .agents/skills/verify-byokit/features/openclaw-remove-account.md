# OpenClaw removeAccount and the orphan sweep

Verification recipe for [removing an account](../../../../docs/runtime-kits.md#515-accounts-one-shared-grant-one-view-per-account-d17) (O14 step S8): `kit.removeAccount('m1', id)` removes one account and leaves no file of it behind.

## Sub-features

- A member-agent account goes through `models.authLogout` with its sealed `profileIds`, then its entry is dropped.
- An account agent goes through `byokit.accounts clear`, an empty `list`, `agents.delete` with `deleteFiles: false`, removal of its `<root>/state/agents/<agent>` dir, then the entry is dropped.
- Removal is refused `busy` while a run holds the agent; the member agent stays `ready`.
- A file the engine lands after removal is swept on the next `prepare` (and after a sealed restore, before launch). Only `<member>--<hex6>` dirs a removal recorded as gone and no index names are swept; a legacy member dir stays.

## How to get to it (user POV)

A person removes an account on a member ("Remove" on the account row). The row disappears; every other account keeps working; nothing of the removed account is left on the computer.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-remove-account.mjs` from the worktree root:

```bash
feature=openclaw-remove-account
entry=.agents/skills/verify-byokit/capture/openclaw-remove-account.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. The consumer imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries, removes an account agent (busy leg first, then the removal, then a late-file prepare sweep) and the member-agent account through `fakeGateway()`, printing the roster, index and authLogout shape. A refresh racing `clear` (still listed after it means stop with "still signing in" and nothing deleted) and the real pinned engine's no-file proof are in `packages/openclaw/test/accounts.test.ts` and `packages/openclaw/test/engine/accounts.test.ts` (`npm run test:engine`). No provider, credential or network is involved.

## Gotchas

The fake gateway holds profile stores in memory: the "late file" leg writes a real file under the removed agent's state dir to stand in for the engine landing one after removal. The real engine's sqlite store, delete semantics and prepare sweep are covered by `removeAccount` in `packages/openclaw/test/engine/accounts.test.ts`.
