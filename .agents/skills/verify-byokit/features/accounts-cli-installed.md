# Installed CLIs in the accounts list, and the Claude judge on them

A host app driving the built `@byokit/accounts/cli` with `installed: true` lists the Claude, Codex and Cursor the person already installed and signed in to under their own HOME, then judges a decide question through the installed Claude with `@byokit/decide/claude-code`, which runs it with that HOME and no `CLAUDE_CONFIG_DIR`. A managed account keeps its own folder.

## Sub-features

- `installed-listed`: `list()` shows one `installed-<provider>` row per CLI in `bins` (`installed: true`), `ready` with email and plan when the CLI's own status command says signed in; managed rows are listed unchanged beside it, and without `installed: true` no installed row appears.
- `installed-probe-env`: the status command runs with the app's `env.HOME`, no `CLAUDE_CONFIG_DIR`, no per-use key (`ANTHROPIC_API_KEY`); Codex gets `CODEX_HOME=<HOME>/.codex`.
- `installed-launch`: `launch('installed-claude')` is `ok` with an empty `set` and the per-use overrides in `unset`; a managed row's `launchEnv` still sets `CLAUDE_CONFIG_DIR` to its folder.
- `installed-decide`: `decide(...)` with `claudeCode({ bin, account: launch })` answers, and the Claude it ran saw the person's HOME and no `CLAUDE_CONFIG_DIR`; with the managed row's `launchEnv` it saw that folder.
- `installed-codex-decide`: the installed Codex's `launch('installed-codex')` drives `@byokit/decide/codex`; see [decide-codex-installed](./decide-codex-installed.md).
- `installed-causes`: a signed-out CLI reads `signed_out` and `launch` refuses with `Claude is not signed in on this computer.`; a missing binary reads `signed_out`, `why: 'unknown'`, `Claude on this computer could not start.`; `folderOf`/`remove` on the installed row throw `unknown-account`; `claudeCode` with both `account` and `configDir` throws.
- `installed-live`: on this box, the real installed `claude` and `codex` (found on PATH) under the person's real HOME show their actual state through `list()`; read-only, labels masked, no decide call.

## How to get to it (user POV)

- The app builds `cliAccounts({ stateDir, bins: { claude, codex }, env: { HOME, PATH }, installed: true })`, shows `list()`, the person picks the installed Claude, and the app passes `await accounts.launch(id)` to `claudeCode({ bin, account, timeoutMs })` for its decide calls.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); the workspace built (`npm run build`). The live leg needs `claude`/`codex` on PATH; a missing one prints `live <provider>: not installed` and is reported unavailable.

- **Write the stand-in.** `"$scratch_dir/bins/claude"`, an executable Node script (absolute `#!` to `node`; load modules with `process.getBuiltinModule('node:fs')`): on `auth status` it appends `{argv, HOME, CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY}` to `$scratch_dir/probe.jsonl` and prints `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"umer@example.test","subscriptionType":"max"}` (`{"loggedIn":false}` when `$scratch_dir/signed-out` exists); otherwise it writes `{HOME, CLAUDE_CONFIG_DIR}` to `$scratch_dir/run.json` and prints one `result` event (`subtype: 'success'`) whose `structured_output` answers every question in the prompt's `questions` with probabilities and `pick` on its first key. `"$scratch_dir/bins/codex"` answers `app-server` JSON-RPC (`id:1` → `{}`, `id:2` → `{account:{email:'umer@example.test',planType:'plus'}}`) and logs its `CODEX_HOME`.
- **Write the consumer.** `"$scratch_dir/verify-accounts-cli-installed.mjs"` importing `cliAccounts` from `@byokit/accounts/cli`, `decide` from `@byokit/decide` and `claudeCode` from `@byokit/decide/claude-code`. Set `process.env.HOME` to a throwaway `$scratch_dir/home` (with a `.claude/.credentials.json` canary) and delete `CLAUDE_CONFIG_DIR`. Print `list()` without and with `installed: true` (after one managed `add('claude')`), the probe log, both `launch`/`launchEnv` sets, one yes/no `decide` through the installed account and one `generate` through the managed one with the stand-in's `run.json` each time, then the error cases. Last, the live leg: a second `cliAccounts` with the real `claude`/`codex` paths, `env: { HOME: os.userInfo().homedir, PATH }`, a scratch `stateDir` and `installed: true`; print each row's provider, state, why, cause and the label masked (`email: present`/`absent`, never the value).
- **Run and capture.** `feature=accounts-cli-installed; entry=@byokit/accounts/cli+@byokit/decide/claude-code; drive=(node "$scratch_dir/verify-accounts-cli-installed.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Expected.** `opt-in off: []`; rows `[managed signing, installed-claude ready, installed-codex ready]`; probe `HOME=<throwaway> CLAUDE_CONFIG_DIR=unset ANTHROPIC_API_KEY=unset`, codex `CODEX_HOME=<throwaway>/.codex`; installed `set {}`, managed `set {CLAUDE_CONFIG_DIR: <folder>}`; decide answer `true` with run `HOME=<throwaway> CLAUDE_CONFIG_DIR=unset`, managed run `CLAUDE_CONFIG_DIR=<folder>`; the signed-out and missing-binary causes and `unknown-account` codes above; canary unchanged; live rows with their real state.
- **Proof.** The captured artifact holds every line above and the final `installed CLIs: OK` line.

## Gotchas

- The stand-in legs never run the real CLI and never read a real `~/.claude`/`~/.codex`: HOME is the throwaway folder. Only the live leg runs the person's installed CLIs, read-only (`auth status`, Codex `account/read`), as the person would; it signs nothing in, makes no model call, and prints no email or plan.
- `claudeCode` inherits the consumer's `process.env`, so set `HOME` and delete `CLAUDE_CONFIG_DIR` in the consumer before the decide legs.
- Non-visual change: no screenshots.
