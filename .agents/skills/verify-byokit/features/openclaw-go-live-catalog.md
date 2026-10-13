# OpenClaw OpenCode Go live catalog

Verification recipe for [live provider catalogs](../../../../docs/runtime-kits.md#live-provider-catalogs-opencode-go) (5.6): with no model config in the app, a Go plan key makes the kit register every live Go model with its own `api`, so `models()` lists `muse-spark-1.3-contributor` and a run on it streams an answer with usage over the Responses API.

## Sub-features

- Before a key nothing is registered; after `addAccount`/`addKey` for `opencode-go`, `models.providers['opencode-go'].models` holds the live list, Muse as `openai-responses` on `https://opencode.ai/zen/go/v1`.
- `kit.models(member, account)` lists Muse `available`; a run on it streams text and ends `ok` with `usage`.
- `models(member, { authChoice: 'opencode-go' })` lists the same live catalog; `addKey({ model })` saves a chosen full id. A key run without `model` streams on that saved choice. An unknown choice returns `{ status: 'invalid', reason: 'model' }` and leaves no ready replacement.
- `run({ auth: 'apiKey', model })` takes any model of the key's provider; another provider ends `plan`.
- `addKey` failures use typed `status` and `reason`, never raw diagnostics: `auth`, `model`, `network`, `engine`, `busy`. The existing public-kit key-entry journey (`packages/openclaw/test/kit.test.ts`) injects typed probe statuses/transport codes carrying a canary and checks each reason and no secret.
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

## Clean-install key-choice and restart qualification

For a task explicitly authorized to use an existing desktop Go key, write a scratch consumer that imports only the built public entry and reads the authorized OpenCode auth file **inside that process** (`JSON.parse(readFileSync(path, 'utf8'))['opencode-go'].key`). Never put the value in argv, an environment assignment, a copied file or keyring. Print only `[masked] (N chars)` and require the value absent from every retained artifact. Use a fresh short, disk-backed scratch root for both `stateDir` and `engineDir` (not RAM-backed `/tmp`); remove it after stopping.

Drive, retaining the actual typed results and streamed output:

1. `kit.start()`, then `kit.addKey('umer', { authChoice: 'opencode-go', apiKey: key, model: 'opencode-go/muse-spark-1.3-contributor' })`: require `{ status: 'ok' }`.
2. `kit.models('umer', { authChoice: 'opencode-go' })`: require Muse present. `kit.run({ member: 'umer', sessionKey: 'agent:umer:proof', auth: 'apiKey', message: 'What is the capital of France?' }, on)`: omit the model to prove the saved choice, require text events and `end.ok`.
3. Add a deliberate synthetic bad key on a different member and require `reason: 'auth'` (not an inference/schema failure).
4. `kit.stop()`, construct a new kit on the same root, `start()` and run again without a model. A refusal here is retained as a restart/readiness limitation, never presented as a successful second run; no workaround or re-add qualifies restart persistence.
5. Verify both probe and run carry `x-opencode-session`. A task-owned observer plugin can subscribe to Node's `undici:request:create` / `undici:request:headers`, restrict to the `opencode.ai` origin, and record **only** phase (`activation`/`first-run`/`restart-run`), header-name presence, and HTTP status. Add its path/id through the app's `plugins.load.paths`/`plugins.allow`; it never changes requests. Require nonzero requests in both phases and header presence on each. Save this structural excerpt beside the transcript; never record header values, bodies or raw engine errors. Stop and remove that observer with the scratch root.

This is nonvisual SDK behavior; no screenshots or provider OAuth/browser sign-in are involved. The offline consumer above proves the saved-model API path but does **not** prove HTTP headers or restart readiness.

## Gotchas

The live leg signs in with `addAccount`, so it needs the Go plan-key setup ([openclaw-go-plan-key](./openclaw-go-plan-key.md)); without it the pinned engine refuses the setup or the legacy `modelPolicy.allow` refuses every Go model. The fake answers `byokit.catalog` with two stand-in models and never restarts; only the live leg shows that the post-activation restart re-syncs, that Muse answers, and that upstream's `inference/go/v1` endpoint is replaced by the pinned one, which otherwise answers `400 Request is missing x-opencode-session`.
