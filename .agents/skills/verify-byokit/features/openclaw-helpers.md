# OpenClaw helpers on a member's account

Verification recipe for [helpers](../../../../docs/runtime-kits.md#583-helpers) (5.8.3): `kit.ensureHelper(member, helper, { account, persona })` records a persona on an account the member already signed in; `kit.run({ member, helper, sessionKey })` speaks as it in its own `agent:<member>:h-<helper>:` sessions on the engine agent holding that account.

## Sub-features

- Two helpers on one account agent and one on the API-key lane: `agentId` is the account's agent, `sessionPrefix` the helper's own; ensuring asks the engine for no agent, config write or sign-in.
- A helper run goes to `agent:<account agent>:h-<helper>:…` with its persona as `extraSystemPrompt`, billed on its account (a key-lane helper names `account: '<provider>.key'`); `RunRef.helper` reaches `ToolHost.gate`.
- Typed `HelperError` refusals with no agent request: `invalid` (id, persona, caller `system`), `unknown_account`, `bound`, `unknown_helper` (never ensured, or its account removed), `session` (another helper's key, a helper key without `helper`, `move` of one).

## How to get to it (user POV)

Umer keeps a "research" and a "writer" helper on the Work ChatGPT account and a "planner" on their API key. Each answers as itself with its own history; none asks Umer to sign in again.

## Driving it

After SKILL.md Launch and Doctor, the built-entry consumer over `fakeGateway()`:

```bash
feature=openclaw-helpers
entry=.agents/skills/verify-byokit/capture/openclaw-helpers.mjs
drive=(node "$entry")
```

Then the real pinned engine leg: persona in each model request and no other's, research's history surviving writer's run, both billed on the same account key, the plan-key helper on its lane key, the sealed stores byte-for-byte unchanged, and refusals with no model request:

```bash
feature=openclaw-helpers
entry=packages/openclaw/test/engine/helpers.test.ts
drive=(env PATH="/usr/bin:$PATH" sh scripts/test.sh "$entry")
```

Use SKILL.md's Evidence capture block for each. Backend behavior: no screenshots. Helpers share their account's engine agent (id, workspace files, memory); separate engine agents per helper need an engine patch and are not claimed here. Not covered: admitting engine-created children aimed at a helper, lifecycle event mapping by helper, adopting legacy sessions, listing or removing a helper.
