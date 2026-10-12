# OpenClaw run on an account

Verification recipe for [a run on an account](../../../../docs/runtime-kits.md#515-accounts-one-shared-grant-one-view-per-account-d17) (O14 step S10): `kit.run({ member, sessionKey, message, account: 'auto' | 'default' | id, model?, needs? })` on a key no account holds yet picks one account once, before any request, and runs on that account's own agent.

## Sub-features

- The first event is `{ type: 'account', account, model, sessionKey, how, why, considered }`, before the `agent` request; an ok end carries `account` and `model`.
- Auto picks the account with the most room; an unbound key that picks an account agent runs as `agent:<account agent>:<tail>`.
- A resting end writes `until` (now + 5 min when the message names none) to the index; the account reads `resting` and the next Auto skips it.
- A chosen account that fails its own `byokit.accounts ready` ends `signed-out` with no agent request; an empty pick (`none`) ends `signed-out`; an id the member does not have throws `unknown account`.
- `needs` alone resolves as `account: 'default'`; with `account` and `needs` both absent the run is the member agent's run it always was, with no account event and no pick.

## How to get to it (user POV)

A person with two ChatGPT accounts sends a message with "Auto" chosen: the reply comes from the account with the most room left, and the app shows which one and why. When that account hits its limit, the next message goes to the other.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-account-run.mjs` from the worktree root:

```bash
feature=openclaw-account-run
entry=.agents/skills/verify-byokit/capture/openclaw-account-run.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. The consumer imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries, signs two ChatGPT accounts in through `fakeGateway()`, and prints each run's account event, end and agent request count: no account, Auto, a resting end and the next Auto, then the signed-out, `none` and unknown-id refusals.

## Gotchas

Session binding (a second run on the same app key staying on its account) is O14 step S11, not this one: every key here is unbound. The fake's usage cache is cold on its first read, so the consumer reads each room once first. Each account billed on its own key, and a signed-out account agent ending `signed-out` while the member agent is signed in, are proved on the real pinned engine by `run({ account })` in `packages/openclaw/test/engine/accounts.test.ts` (`npm run test:engine`). No provider, credential or network is involved.
