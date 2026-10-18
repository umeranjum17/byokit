# OpenClaw engine uses the person's installed CLI logins

Verification recipe for [the engine env](../../../../docs/runtime-kits.md#55-isolated-engine-env): the agent CLIs the engine drives (Claude Code, Codex and the rest) run with the person's own `HOME` and no engine-root `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so a signed-in installed Claude Code works with no sign-in step; with no installed sign-in the engine falls back to its own Claude folder and still offers the phone-started sign-in.

## Sub-features

- Installed Claude Code signed in: the gateway's env carries the person's `HOME`, no `CLAUDE_CONFIG_DIR`, no `CODEX_HOME`; every `claude`/`codex` call the kit or engine makes sees the same; `signedIn('umer', 'claude-cli')` is true and a `claude-cli` run answers, with no sign-in.
- No installed sign-in: the next start sets `CLAUDE_CONFIG_DIR=<stateDir>/openclaw/home/.claude` (the fallback folder), `HOME` stays the person's, and `signIn(member, { authChoice: 'anthropic-cli' })` shows the fallback's sign-in address; cancel declines.
- The person's own `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, when set, pass through; the env facts also run offline in `npm test` through `packages/openclaw/test/isolation-contract.ts` (decoy HOME as the person's home, nothing written into it, fallback leg) and against the pinned engine in `test/engine/isolation.test.ts`.

## Drive

After SKILL.md Launch and Doctor. The consumer installs the pinned engine into the scratch root (network once, then loopback only) and runs with `HOME` set to a stand-in person home inside that root; it refuses any other HOME, so the real `~/.claude` and `~/.codex` are never read. Linux only (it reads the gateway's `/proc/<pid>/environ` for the three names; the token is never printed).

```bash
feature=openclaw-installed-cli-login
entry=.agents/skills/verify-byokit/capture/openclaw-installed-cli-login.mjs
scratch_root="$HOME/.cache/fm-scratch/openclaw-installed-cli-login"; mkdir -p "$scratch_root/person"
drive=(env HOME="$scratch_root/person" node "$entry" "$scratch_root" --expect-fix)
```

Use SKILL.md's Evidence capture block. Expected: leg `installed login signed in` prints `gatewayEnv` with `HOME` = the stand-in home and no `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, `signedInClaudeCli: true`, `run.text: "Hello Umer"`, and `cliCalls` all with that HOME alone; leg `no installed login` prints `CLAUDE_CONFIG_DIR` = `<state>/openclaw/home/.claude`, `fallbackOffered.url` `https://claude.example.test/authorize`, `afterCancel` `failed`/`declined`; the last line is `PASS`. For the before state, run the same consumer without `--expect-fix` against a build of the base ref (copy the capture next to that build so `@byokit/openclaw` resolves there): it prints the engine-root `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` and `signedInClaudeCli: false`.

Remove the scratch root afterwards (it holds the engine sets). Not proven here: a real Claude or ChatGPT subscription turn (the stand-ins answer offline).
