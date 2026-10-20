# OpenClaw remove a saved key

Verification recipe for key removal (5.7/5.8): `kit.removeKey(member, o?)` clears the member's saved key lane, the
reserved `byokit-key-<member>` agent, and `kit.signOut(member, provider)` removes that provider's saved key too. A
saved key is not a member-agent profile, so before this the member-agent logout left the seal and its ready marker in
place and the member read signed in again after an engine restart.

## Sub-features

- `removeKey(member)` clears the lane's credential store and its ready marker through `byokit.keys clear`, so
  `signedIn(member, provider)` is false and an `auth: 'apiKey'` run ends `signed-out` with no engine request.
- `accounts(member)` lists `<provider>.key` after `addKey` and no lane row after `removeKey` or that provider's
  `signOut`; another provider's sign-out keeps the row.
- The removal survives an engine restart: a fresh kit on the same state reads the same signed-out lane (nothing
  revives a key with no marker, and the start sweep sees the lane removed).
- `removeKey(member, { provider })` removes the saved key only when the ready marker's saved model names that
  provider; another provider's key is untouched. `signOut(member, provider)` calls it after the member-agent logout.
- A member with no saved key is a no-op that resolves: the shipped handler answers a `clear` for a lane that is not
  there with `{ ok: false, absent: true }`. A refused read or clear throws `The key could not be removed.`, never raw
  engine text.
- The key value never appears in calls, results, logs or evidence.

## How to get to it (user POV)

A person signs out of their OpenCode Go plan key and stays signed out after the app restarts, instead of being signed
back in by the sealed key the member-agent logout could not reach.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer from the worktree root:

```bash
feature=openclaw-key-remove
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-key-remove.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. It is offline: the built public entry over `fakeGateway()` on loopback, which
mirrors the shipped `byokit.keys` handler, including its `absent` reply for a lane that was never created. Nonvisual
SDK behavior: no screenshots, no real provider, no credential.

## Gotchas

A real restart is a fresh `new OpenClawKit` on the same `stateDir`, then `start()` (the fake keeps the roster and the
key map across kit instances, as the engine keeps its config and the key agent's directory). The fake never restarts
the gateway on its own, so the restart leg is the only one that proves the removal is durable rather than
session-local. `packages/openclaw/test/kit.test.ts` drives the same journey in the repo suite; the live engine
counterpart is `test/engine/signin.test.ts` (`npm run test:engine`).
