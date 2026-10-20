# The Codex judge on the person's installed, signed-in Codex

`@byokit/decide/codex` runs the person's own unmodified `codex` (`codex exec --json --output-schema`) with their HOME and no `CODEX_HOME` for the installed account from `@byokit/accounts/cli` (`installed: true`, id `installed-codex`), so a decide call answers on their ChatGPT plan with the model the app names (for example `gpt-6-luna`). A managed account sets its own `CODEX_HOME`. The kit never opens `~/.codex`.

## Sub-features

- `codex-installed-decide`: `decide(...)` with `codex({ bin, account: await accounts.launch('installed-codex'), model })` answers with a probability, pick and rationale; the run saw the person's HOME, no `CODEX_HOME`, no `OPENAI_API_KEY`/`OPENAI_BASE_URL`, and `exec --json --ephemeral --ignore-user-config --sandbox read-only --model <model>` with the schema file and ChatGPT login forced.
- `codex-managed-account`: a managed row's `launchEnv(id)` sets `CODEX_HOME` to its folder; an account setting anything else throws `Pass a Codex account from @byokit/accounts.`
- `codex-refusals`: `codex login status` other than `Logged in using ChatGPT` (API key, signed out) is `CodexError` `subscription_required` with no `exec`; a missing binary is `CodexError` `process`; malformed, failed-turn and off-schema answers are `invalid_json`, `process` and `invalid_output`, never stderr text.
- `codex-live`: on this box, one real `decide` call through the installed signed-in `codex` to `gpt-6-luna`, showing the answer.

## How to get to it (user POV)

- The app builds `cliAccounts({ stateDir, bins: { codex }, env: { HOME, PATH }, installed: true })`, the person picks the installed Codex, and the app passes `await accounts.launch('installed-codex')` to `codex({ bin, account, model: 'gpt-6-luna', timeoutMs })` for its decide or generate calls.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); the workspace built (`npm run build`); `codex` on PATH and signed in with ChatGPT for the live leg (a missing one prints `live codex: not installed` and is reported unavailable). Live model calls need the captain's approval for that model (Luna approved until 21 Oct 2026).

- **Stand-in legs.** Covered offline by `packages/decide/test/generate.test.ts` (`the installed Codex from the accounts list ...`): fake `codex` on PATH answering `app-server`, `login status` and `exec`, every sub-feature above except `codex-live`. Run `sh scripts/test.sh packages/decide/test/generate.test.ts`.
- **Write the consumer.** `"$scratch_dir/verify-decide-codex.mjs"` importing `cliAccounts` from `@byokit/accounts/cli`, `decide` from `@byokit/decide` and `codex`, `CodexError` from `@byokit/decide/codex`. Resolve the real `codex` on PATH. (1) Error leg: `codex({ bin: '<scratch>/not-installed', timeoutMs })` decides and prints the caught `name`/`code`/`message`. (2) Live leg: `cliAccounts({ stateDir: '<scratch>/plans', bins: { codex: real }, env: { HOME: os.userInfo().homedir, PATH }, installed: true })`; print the `installed-codex` row's state and `email: present`/`absent` (never the value); `launch('installed-codex')` and print `set`; one `decide({ name: 'Umer', draft: ... }, { short: { kind: 'yesno', question, personReason: true } }, { privacy: 'may-leave', backends: [codex({ bin: real, account: launch, model: 'gpt-6-luna', timeoutMs: 180_000 })] })`; print answer, confidence, probabilities, rationale, personReason, usage and elapsed ms.
- **Run and capture.** `feature=decide-codex-installed; entry=@byokit/decide/codex; drive=(node "$scratch_dir/verify-decide-codex.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Expected.** (1) `CodexError process`. (2) row `ready`, `set {}`, a boolean answer with probabilities summing to 1, a rationale, token usage, and the final `codex decide: OK` line.

## Gotchas

- The live leg runs the person's installed `codex` as they run it (their HOME, their sign-in); the consumer never reads, copies or prints `~/.codex` or any login file, and prints no email or plan.
- `codex` inherits the consumer's `process.env`; do not set `CODEX_HOME` in the consumer.
- Non-visual change: no screenshots.
