# OpenClaw add a second ChatGPT account

Verification recipe for [adding an account](../../../../docs/runtime-kits.md#515-accounts-one-shared-grant-one-view-per-account-d17) (O14 step S6): `kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, on)` signs a member's first ChatGPT account in on the member agent and each further one on a new sealed agent `m1--<hex6>`, so one member can hold two ChatGPT accounts. A cancelled, failed or busy sign-in leaves no agent or index entry behind.

## Sub-features

- The account id is `<provider>.<hex6>` on agent `<member>--<hex6>`, drawn again while that agent exists; the index entry is written before the agent.
- The shared workspace's IDENTITY.md stays byte-identical (the pin rewrites its Name line on create; the kit puts the member's back).
- The ChatGPT authorize URL carries `prompt=login` for a further account, so the person can pick another login.
- The row reads `signing` while the sign-in runs; `done` comes only after the agent is sealed and its `who` hash is indexed.
- A second sign-in while one runs ends `why: 'busy'`; a non-subscription auth choice is refused with `not a subscription sign-in`.

## How to get to it (user POV)

A person already signed in to ChatGPT taps "Add another ChatGPT account" on a member. The browser opens on OpenAI's login screen rather than reusing the session; after signing in, the member lists two ChatGPT accounts.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-add-account.mjs` from the worktree root:

```bash
feature=openclaw-add-account
entry=.agents/skills/verify-byokit/capture/openclaw-add-account.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. The consumer imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries, adds two ChatGPT accounts through `fakeGateway()`, prints the URL, rows, roster and index, then cancels a third and passes an API-key choice to show the refusal.

## Gotchas

The fake gateway does not stamp `agents.ownership: 'explicit'` or rewrite IDENTITY.md the pin's exact way; the real pinned engine's IDENTITY.md bytes, ownership stamp, authorize URL and cancel cleanup are covered by `addAccount` in `packages/openclaw/test/engine/accounts.test.ts` (`npm run test:engine`). The collision redraw and busy legs are in `packages/openclaw/test/accounts.test.ts`. No provider, credential or network is involved.
