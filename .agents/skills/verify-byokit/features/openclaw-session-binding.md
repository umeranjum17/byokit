# OpenClaw session binding

Verification recipe for [session binding](../../../../docs/runtime-kits.md#515-accounts-one-shared-grant-one-view-per-account-d17) (O14 step S11, Runs steps 1, 2 and 8): every run first finds the account its session is bound to, so a conversation never switches account mid-way.

## Sub-features

- A second run on one app key stays on the account agent that holds `agent:<that agent>:<tail>` (found with `sessions.resolve { allowMissing: true }`, member agent first), with no account named, with `'auto'`, and by its engine key `agent:<member>--<hex6>:<tail>`.
- `kit.pick(member, sel, { sessionKey })` equals the run's account event on the same state, `considered` included: unbound, bound to an account agent, bound to the member agent (Auto only among the member agent's accounts, others `out: 'bound'`).
- A bound key refuses another id (`code: 'bound'`, words `account.bound`); an API-key conversation refuses anything but its own id (`code: 'paid'`, words `account.paid`); the run ends `{ ok: false, kind: 'other', message }` with no event and no agent request.
- `steer`/`abort` with the app key reach the live run's engine key.
- A `<member>--<hex6>` key the index does not name is refused as not the member's.

## How to get to it (user POV)

A person with two ChatGPT accounts starts a chat on Auto, which lands on Personal. Later Work has more room, but the same chat keeps answering from Personal; choosing Work for that chat shows "This conversation uses Personal. Move it to switch accounts." instead of switching.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-session-binding.mjs` from the worktree root:

```bash
feature=openclaw-session-binding
entry=.agents/skills/verify-byokit/capture/openclaw-session-binding.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. The consumer imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries and prints each pick and run (account event, end, agent request count), the steer/abort keys and the refusal; it ends `SESSION-BINDING OK`.

## Gotchas

The API-key account is written into the index by hand (an account agent signed in through the fake's `openclaw.setup.activate`), because `addKey` as an account arrives in a later O14 step. The fake records a session when a run's `agent` request lands, so a chosen account that ends `signed-out` before any request leaves its key unbound. Switching a bound conversation is `move`: [OpenClaw move](./openclaw-move.md). No provider, credential or network is involved.
