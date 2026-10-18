# Decide Claude-judge flags

The `claudeCode` backend shells out to the person's own installed, signed-in `claude` binary for subscription judging, with their HOME, PATH and environment, so their existing sign-in answers and the kit keeps no sign-in of its own. The flag list it builds must be accepted by the installed CLI; a refused flag pair fails every judge call with a generic process error.

## Sub-features

- `claude-own-sign-in`: `claudeCode({ bin, timeoutMs })` with no `configDir` runs a stand-in `claude` with the consumer's own HOME and PATH and no `CLAUDE_CONFIG_DIR`, and the stand-in's stream-json answer validates; with `configDir`, the stand-in receives `CLAUDE_CONFIG_DIR` exactly as given.
- `claude-flags-accepted`: with a `claude` binary on PATH and an empty scratch sign-in dir, `generate` surfaces the typed not-signed-in failure (`ClaudeCodeError`; the CLI's `auth status` exits 1 when logged out) instead of a flag-combination refusal, leak or hang. The generation args use `--output-format stream-json --verbose` with `--input-format stream-json`, and the adapter answers from the final `result` event (covered against the real CLI by the `generate.test.ts` replay test).
- `claude-absent-is-process-error`: with no binary at the given path, `generate` rejects with `ClaudeCodeError` (never a raw spawn error or hang).

## How to get to it (user POV)

- The app judges a typed question through `claudeCode({ bin, timeoutMs })` using the person's own installed, signed-in Claude (an optional `configDir` is passed through as `CLAUDE_CONFIG_DIR`).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); `claude` on PATH for the accepted-flags drive (skip that drive with reason when absent); the workspace built (`npm run build`).

- **Write the stand-in.** `"$scratch_dir/claude"`, an executable Node script (absolute `#!` to `node`; load modules with `process.getBuiltinModule('node:fs')`, since the worktree's `package.json` makes an extensionless script ESM) that appends the `HOME`, `PATH` and `CLAUDE_CONFIG_DIR` it receives to a log in `$scratch_dir`, answers `auth status` with `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}`, and otherwise prints one `result` event with `subtype: 'success'` and a `structured_output` matching the schema.
- **Write the consumer.** `"$scratch_dir/verify-decide-claude-flags.mjs"` importing `{ claudeCode }` from `@byokit/decide/claude-code`: (1) `claudeCode({ bin: <stand-in>, timeoutMs })` `generate`s a minimal object schema; print the parent HOME/PATH, the stand-in's received values and the validated answer; (2) the same with `configDir: <scratch dir>`; (3) against an empty scratch `configDir` and the real `claude` binary, run in a child Node process whose `HOME`/`XDG_*` point at a scratch dir, `generate` and print the caught error's `name`/`code`; (4) against a missing binary path, print that caught error's `name`/`code`.
- **Run and capture.** `feature=decide-claude-flags; entry=@byokit/decide/claude-code; drive=(node "$scratch_dir/verify-decide-claude-flags.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Expected.** (1) received HOME and PATH equal the parent's, `CLAUDE_CONFIG_DIR` unset, answer validated. (2) received `CLAUDE_CONFIG_DIR` equals the given dir. (3) `ClaudeCodeError` (the typed not-signed-in failure — never `requires output-format`, `invalid_json`, a hang, or a raw spawn error). (4) `ClaudeCodeError`. No secrets in evidence (config dirs are empty scratch dirs).

## Gotchas

- Import public entries only (`@byokit/decide/claude-code`); never `packages/decide/src` or `packages/decide/dist`.
- The drive never signs in and never touches the person's real `~/.claude`: the adapter now runs the binary with the caller's own HOME, so every real-`claude` leg runs from a child process whose HOME and `XDG_*` are a scratch dir, with an empty scratch `configDir`; the own-HOME legs use the stand-in only.
- The live leg with the person's real subscription sign-in is not driven here: Claude subscription legs are tested by the captain.
- Non-visual change: no screenshots.
