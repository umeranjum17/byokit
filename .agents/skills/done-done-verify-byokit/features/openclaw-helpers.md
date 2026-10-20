# OpenClaw helpers on a member's account

Verification recipe for [helpers](../../../../docs/runtime-kits.md#583-helpers) (5.8.3): `kit.ensureHelper(member, helper, { account, persona })` records a persona on an account the member already signed in; `kit.run({ member, helper, sessionKey })` speaks as it in its own `agent:<member>:h-<helper>:` sessions on the engine agent holding that account.

## Sub-features

- Two helpers on one account agent and one on the API-key lane: `agentId` is the account's agent, `sessionPrefix` the helper's own; ensuring asks the engine for no agent, config write or sign-in.
- A helper run goes to `agent:<account agent>:h-<helper>:…` with its persona as `extraSystemPrompt`, billed on its account (a key-lane helper names `account: '<provider>.key'`); `RunRef.helper` reaches `ToolHost.gate`.
- Typed `HelperError` refusals with no agent request: `invalid` (id, persona, caller `system`), `unknown_account`, `bound`, `unknown_helper` (never ensured, or its account removed), `session` (another helper's key, a helper key without `helper`, `move` of one).
- Delegated helper runs (S2): a `helperDelegates` run's native `sessions_send` to the exact `agent:<agent>:h-<helper>:<rest>` key (account agent and key lane) is admitted from its receipt as that helper (`RunRef.helper`, the parent's member, `parent` identity) on gate and call; an unreceipted helper key never reaches the gate; refusals `session` (not a helper key, or a helper not given), `bound` (another account), `unknown_helper` (never ensured) reach the parent's tool result; `abort(root)` drops the parked approval and runs nothing; removing the helper's account ends the admitted child at its next call.
- Delegated lifecycle by helper (S3): `byokit.delegated` reports `admitted` with `run.helper` and `run.tools` (the child's app-tool subset), the engine's events, then one `ended` whose `reason` is `terminal`, `cancelled` (an abort or ended admission), `error` (`message`) or `resting` (the model's usage limit: the helper's account rests `until`, as a kit run's resting end does); a gate or native approval on a helper's run carries `helper`.

- Legacy adoption (S4): `kit.adoptHelperSession({ member, sessionKey }, helper)` forks a plain member conversation from before helpers into `agent:<member>:h-<helper>:<tail>` on the helper's account agent with no model request and deletes the old session; one parked on its approval answers `busy` and keeps its key and approval until it settles; a helper key is refused `session`. Real engine: the legacy conversation survives a kit restart, adopts, and research's next turn holds its history under its persona on the same account key.

## How to get to it (user POV)

Umer keeps a "research" and a "writer" helper on the Work ChatGPT account and a "planner" on their API key. Each answers as itself with its own history; none asks Umer to sign in again. Research's conversations from before helpers become research's own.

## Driving it

After SKILL.md Launch and Doctor, the built-entry consumer over `fakeGateway()`:

```bash
feature=openclaw-helpers
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-helpers.mjs
drive=(node "$entry")
```

Then the real pinned engine leg: persona in each model request and no other's, research's history surviving writer's run, both billed on the same account key, the plan-key helper on its lane key, the sealed stores byte-for-byte unchanged, refusals with no model request, and the delegated leg (research's real `sessions_send` children on writer and the plan-key planner gated and called as those helpers, a rogue helper-key run never gated, a typed `bound` refusal, abort revoking a parked child; the lifecycle by helper: `run.tools`, finished and cancelled ends, the parked approval's `helper`, and a usage-limited child ending `resting` with its account resting) and the legacy adoption leg:

```bash
feature=openclaw-helpers
entry=packages/openclaw/test/engine/helpers.test.ts
drive=(env PATH="/usr/bin:$PATH" sh scripts/test.sh "$entry")
```

Use SKILL.md's Evidence capture block for each. Backend behavior: no screenshots. Helpers share their account's engine agent (id, workspace files, memory); separate engine agents per helper need an engine patch and are not claimed here. A delegated child runs without the helper's persona (a native send carries no system text). Not covered: listing or removing a helper.
