# OpenClaw installed CLI logins

Verification recipe for [the engine environment](../../../../docs/runtime-kits.md#55-isolated-engine-env). The gateway keeps config, sessions and workspace in the kit root, while agent CLIs use the person's HOME. The gateway and doctor use `CODEX_HOME=<root>/home/.codex`: upstream must never import or refresh the installed Codex login. Only the supported `registerCliBackend` adapter removes that override for `codex exec`; admission asks `codex login status`, never reads credentials. No engine patch, credential copy or link.

## Sub-features

- Installed Claude stand-in: normal HOME, no engine-root CLAUDE_CONFIG_DIR, `signedIn('umer', 'claude-cli')` true, `kit.accounts('umer')` lists it as a `ready` account whose `kit.models` rows include available `claude-cli/*` models, and a Claude run answers.
- Installed Codex stand-in: `openai-codex/gpt-6-luna` answers through a real spawned CLI process with normal HOME and no CODEX_HOME override. Its login-status command, not a file read, establishes ChatGPT readiness. A sign-out marker makes the next checked run end `signed-out`.
- Synthetic Codex login canary: deliberately old access/modification times remain unchanged after gateway start, Claude/Codex chats, status checks and shutdown. This repro's "installed login read" always refers to the throwaway person's canary, never an owner's actual login.
- Claude fallback: no installed sign-in sets `<root>/home/.claude` only for Claude, still offers phone-started login, and cancel declines. Engine CODEX_HOME stays isolated in both legs.
- Claude login cause (Crewhouse K3): with no installed sign-in, a `claude-cli` run before any sign-in ends `signed-out` with `cause: { code: 'needs_cli_login', cli: 'claude', home: <root>/home, configDir: <the engine's folder>, signIn: true }`; with an unanswered installed-status probe the engine keeps the person's login location, and both the run and `signIn('anthropic-cli')` carry `{ code: 'needs_cli_login', cli: 'claude', home: <person HOME>, signIn: false }`.
- Offline environment contract: `packages/openclaw/test/isolation-contract.ts`; pinned-engine environment: `test/engine/isolation.test.ts`; Codex chat and isolated-login regression: `test/engine/run.test.ts` (`installed Codex`).

## Drive

After SKILL.md Launch and Doctor. All CLIs are offline stand-ins; the real pinned gateway is installed in task-owned storage. HOME must be inside the supplied scratch root. No real CLI login is read or copied. Linux only (`/proc/<owned-pid>/environ` is used for selected nonsecret environment fields).

```bash
feature=openclaw-installed-cli-login
entry=.agents/skills/verify-byokit/capture/openclaw-installed-cli-login.mjs
# Use short temporary state paths (Unix sockets have a ~108-byte ceiling).
# Keep the bulky engine on disk: BYOKIT_TEST_ENGINE_DIR names this task's existing external engine set.
scratch_root=$(mktemp -d /tmp/boc.XXXXXX); mkdir -p "$scratch_root/person"
drive=(env HOME="$scratch_root/person" node "$entry" "$scratch_root" --expect-fix)
```

Use SKILL.md's Evidence capture block, storing evidence outside the worktree when the task requires it. Expected: Claude replies `Hello Umer`; Codex replies `Hello Umer from Luna`; the missing-login leg returns the actual signed-out result; fallback offers `https://claude.example.test/authorize` after a run that ends `signed-out` with the `signIn: true` cause; the unknown-status leg's run and sign-in carry the `signIn: false` cause; `canaryLoginUnreadAndUnchanged: true`; final `PASS`. Every Codex model call has the stand-in HOME and no CODEX_HOME, while gatewayEnv retains the kit-root CODEX_HOME. Upstream's discovery-only `--version`/`login status` probes inherit that safe override; these probes never read the person's real login and are not the model path. No images apply to this nonvisual backend change.

The existing fake-Codex engine integration also checks that engine-generated MCP overrides and ChatGPT-only/native-shell-disabled arguments reach the CLI. This is not a live subscription/tool-use acceptance claim. A real installed, signed-in Codex/Luna turn requires separate explicit authorization; if authorization is synthetic-only, record that live proof as **not performed** rather than substituting these replies for provider evidence.

Remove the task scratch in the same shell (`rm -rf -- "$scratch_root"`); retain evidence logs outside it. Never install the bulky engine under `/tmp`.

## Explicitly authorized live subscription proof

One built-public-entry consumer creates a short task-owned stateDir, reuses its own pinned engine set, and exposes only a symlink to the installed `codex` binary on enginePath (never a login file). It runs `kit.run({ member: 'umer', sessionKey: 'agent:umer:crewhouse:luna', model: 'openai-codex/gpt-6-luna', message: 'Reply with exactly: Hello Umer from Luna' })` with normal HOME. Capture the actual reply and model-spawn metadata (HOME and absence of CODEX_HOME only); shebang-normalized executions can be `/bin/sh <installed-wrapper> exec ...`, so identify the `exec`/`--model` arguments, not only the executable basename. An observation preload may forward the original spawn unchanged; do not replace the CLI or the model response.

Before start and after stop, compare only `statSync(<normal HOME>/.codex/auth.json).mtimeNs`, never read or print the contents. Report whether the installed CLI itself changed its login. Assert gateway OPENCLAW_HOME/STATE_DIR/CONFIG_PATH and CODEX_HOME remain task-owned; combine the actual CLI-spawn witness with the separate canary journey above, which proves the engine does not read that person's login. Bound the chat, abort/stop in finally, remove temporary state, and retain the metadata log and result. A successful model response without a model-spawn witness is an incomplete proof, not permission to invent one.
