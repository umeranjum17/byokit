# OpenClaw OpenCode Go live catalog

Verification recipe for [live provider catalogs](../../../../docs/runtime-kits.md#live-provider-catalogs-opencode-go) (5.6): with no model config in the app, a Go plan key makes the kit register every live Go model with its own `api`, so `models()` lists `muse-spark-1.3-contributor` and a run on it streams an answer with usage over the Responses API.

## Sub-features

- Before a key nothing is registered; after `addAccount`/`addKey` for `opencode-go`, `models.providers['opencode-go'].models` holds the live list, Muse as `openai-responses` on `https://opencode.ai/zen/go/v1`.
- `kit.models(member, account)` lists Muse `available`; a run on it streams text and ends `ok` with `usage`.
- `run({ auth: 'apiKey', model })` takes any model of the key's provider; another provider ends `plan`.
- After `addKey`, `signedIn(member, 'opencode-go')` is true while `providers(member)` stays the member's own sign-ins; live, a second member's key run on Muse streams with usage.
- A fresh start finds the list unchanged and writes nothing (no gateway restart, no config rewrite).

## How to get to it (user POV)

A person adds their OpenCode Go plan key and picks Muse Spark in the model list; the agent answers on it.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer from the worktree root:

```bash
feature=openclaw-go-live-catalog
entry=.agents/skills/verify-byokit/capture/openclaw-go-live-catalog.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. Offline it drives `fakeGateway()` through the key path. The live leg (`drive=(node "$entry" --live)`) is a credential-touching proof: put the key in env `BYOKIT_GO_KEY` (never argv), optionally point `BYOKIT_TEST_ENGINE_DIR` at an installed engine set, hold the heavy-job lock, and run SKILL.md's `leak_check` on the key afterwards. The live engine home lives in the OS temp dir and is removed.

## Gotchas

The live leg signs in with `addAccount`, so it needs the Go plan-key setup ([openclaw-go-plan-key](./openclaw-go-plan-key.md)); without it the pinned engine refuses the setup or the legacy `modelPolicy.allow` refuses every Go model. The fake answers `byokit.catalog` with two stand-in models and never restarts; only the live leg shows that the post-activation restart re-syncs, that Muse answers, and that upstream's `inference/go/v1` endpoint is replaced by the pinned one, which otherwise answers `400 Request is missing x-opencode-session`.
