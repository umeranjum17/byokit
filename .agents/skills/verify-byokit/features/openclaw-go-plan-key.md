# OpenClaw OpenCode Go plan key

Verification recipe for [plan-key sign-in](../../../../docs/runtime-kits.md#57-sign-in-routes-and-retained-login-migration) (D12): `kit.addAccount(member, { authChoice: 'opencode-go' }, on)` asks for `Plan key`, pastes it into typed `openclaw.setup.activate`, and the member's first run after `done` answers on the plan, streamed with usage. Discovery never calls a choice `ready` that the pinned Gateway refuses.

## Sub-features

- `opencode-go` reads `ready`; a choice the engine cannot set up (`fal-api-key`) reads `no_upstream_flow`, and its sign-in fails with the engine's words.
- The view is `{ state: 'waiting', prompt: 'Plan key' }`; the key never appears in a view, result or log.
- The account row is `opencode-go`, `subscription`, `ready`; a run with no model named, started on `done`, streams an answer with `usage`.
- `kit.addKey(member, { authChoice: 'opencode-go', apiKey })` is `ok`, and `run({ auth: 'apiKey' })` answers on the key's saved model.
- Every Go request carries a stable `x-opencode-session` per conversation (the pin's wrapper); live, Go answers only with it, and `test/engine/accounts.test.ts` asserts it on the activation probe and each run.

## How to get to it (user POV)

A person picks OpenCode Go in Add an account, pastes the key from their OpenCode Go dashboard, and asks the agent something; it answers on the plan.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer from the worktree root:

```bash
feature=openclaw-go-plan-key
entry=.agents/skills/verify-byokit/capture/openclaw-go-plan-key.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. Offline it drives `fakeGateway()`. The live leg (`drive=(node "$entry" --live)`) is a credential-touching proof: put the key in env `BYOKIT_GO_KEY` (never argv), optionally point `BYOKIT_TEST_ENGINE_DIR` at an installed engine set, hold the heavy-job lock, and run SKILL.md's `leak_check` on the key afterwards. The live engine home lives in the OS temp dir and is removed.

## Gotchas

The fake never restarts; the real gateway restarts after activation (its `auth` write), and `done` waits it out, so only the live leg or `test/engine/accounts.test.ts` (`npm run test:engine`, opencode.ai answered by the loopback stub) shows that a first run lands on the plan rather than ending `signed-out` for openai. `test/engine/signin.test.ts` holds every ready and absent choice to the real Gateway. A run resolves only static or configured Go models: a live-only one (Muse) needs `config.models.providers['opencode-go']` with `api: 'openai-responses'` (README), and a key runs only its saved model.
