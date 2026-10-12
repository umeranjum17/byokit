# Decide Claude-judge flags

The `claudeCode` backend shells out to a host-owned `claude` binary for subscription judging. The flag list it builds must be accepted by the installed CLI before sign-in; a refused flag pair fails every judge call with a generic process error.

## Sub-features

- `claude-flags-accepted`: with a `claude` binary on PATH and an empty scratch sign-in dir, `generate` surfaces the typed not-signed-in failure (`ClaudeCodeError`; the CLI's `auth status` exits 1 when logged out) instead of a flag-combination refusal, leak or hang. The generation args use `--output-format stream-json --verbose` with `--input-format stream-json`, and the adapter answers from the final `result` event (covered against the real CLI by the `generate.test.ts` replay test).
- `claude-absent-is-process-error`: with no binary at the given path, `generate` rejects with `ClaudeCodeError` (never a raw spawn error or hang).

## How to get to it (user POV)

- The app judges a typed question through `claudeCode({ bin, configDir, timeoutMs })` using the person's own Claude subscription sign-in.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); `claude` on PATH for the accepted-flags drive (skip that drive with reason when absent); the workspace built (`npm run build`).

- **Write the consumer.** `"$scratch_dir/verify-decide-claude-flags.mjs"` importing `{ claudeCode }` from `@byokit/decide/claude-code`: against an empty scratch `configDir` and the real `claude` binary, `generate` a minimal object schema and print the caught error's `name`/`code`; then against a missing binary path, print that caught error's `name`/`code`.
- **Run and capture.** `feature=decide-claude-flags; entry=@byokit/decide/claude-code; drive=(node "$scratch_dir/verify-decide-claude-flags.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Expected.** Real binary, empty sign-in dir: `ClaudeCodeError` (the typed not-signed-in failure — never `requires output-format`, `invalid_json`, a hang, or a raw spawn error). Missing binary: `ClaudeCodeError`. No secrets in evidence (config dirs are empty scratch dirs).

## Gotchas

- Import public entries only (`@byokit/decide/claude-code`); never `packages/decide/src` or `packages/decide/dist`.
- The drive never signs in and never touches the person's real `~/.claude`: `configDir` is always an empty scratch dir, and the adapter runs the binary with a scratch HOME.
- Non-visual change: no screenshots.
