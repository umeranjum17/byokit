# OpenClaw damaged account-index quarantine

Verification recipe for a scoped recovery when `accounts/<member>.json` is unreadable: that member's agents stay sealed (held back — not restored, not swept, not resealed away), other members restore and run normally, the kit reports words `account.indexDamaged`, and a re-add rewrites a good index. A removed account's data still never returns through the gap (PR 537 fail-closed).

## Sub-features

- One damaged index among good ones does not block restore, start or stop-time persist of the sealed store.
- The damaged file is kept on disk (never silently deleted).
- `kit.accounts(member)` rejects with the plain-words `account.indexDamaged` sentence; the kit log carries the same sentence.
- Re-add on the damaged member rewrites a readable index and lists the new account.

## How to get to it (user POV)

A person's account list for one member cannot be opened (corrupt file). Other people on the device keep working. The app says the list is paused and to add the account again; after they do, that member works again.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-index-recovery.mjs` from the worktree root:

```bash
feature=openclaw-index-recovery
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-index-recovery.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. The consumer imports only the built `@byokit/openclaw`, `@byokit/openclaw/testing` and `@byokit/secrets` entries, drives a sealed fake-gateway home with two members, damages one index, proves the other still lists, the damaged member rejects with words, the held agent is not restored, and a re-add repairs the index. No provider, credential or network is involved.
