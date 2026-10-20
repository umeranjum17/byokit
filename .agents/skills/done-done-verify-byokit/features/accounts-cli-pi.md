# Managed Pi usage (folder login)

A host app driving the built `@byokit/accounts/cli` sees how much room a managed Pi account has left, the same way it already sees it for Codex and Cursor. `add('pi', { piProvider })` keeps each account's own login in `<stateDir>/pi/<hex>/auth.json`; `usageSource(id)` hands that folder to `@byokit/usage` as `{provider:'pi', folder, piProvider}`, which reads the token in process and reports the plan that Pi provider names — ChatGPT's Codex windows for `openai-codex`, Kimi's window for `kimi-coding`. Every other Pi provider has no route and reports its room as `unknown`. `pick('pi')` reads the same source, so a pool `list` and the pool view agree. Fakes only: no real Pi login, no owner folder read, and the one live read with a real login runs under the credential lock before any product view depends on it.

## Sub-features

- `cli-pi-usage-source`: `await usageSource(id)` is `{provider:'pi', folder, piProvider}` for the `openai-codex` and `kimi-coding` rows and `undefined` for a Pi provider with no quota route; the folder is that account's own `launchEnv(id).set.PI_CODING_AGENT_DIR`, and two Pi accounts never share one.
- `cli-pi-usage-codex`: for `openai-codex`, `pick('pi')` reads ChatGPT's Codex windows (`GET chatgpt.com/backend-api/wham/usage`) addressed by the account's own `ChatGPT-Account-Id` and its own `Bearer` token, so the row's `room.left` and both windows match the quota body; a roomier row wins and equal room keeps list order.
- `cli-pi-usage-kimi`: for `kimi-coding`, the same read goes to `api.kimi.com/coding/v1/usages` with that account's own bearer and parses Kimi's weekly window (`used`/`remaining`/`resetTime`).
- `cli-pi-usage-unknown`: a Pi provider with no route is `unknown`, never zero; a missing or malformed folder login is `unknown`, never zero; no token, folder path or response body reaches a row, the plans store or the output.
- `cli-pi-launch-model`: `launchArgs(id, model)` for a Pi row is `['--provider', piProvider, '--model', model]`; with no model (or an empty or `-`-leading one) it throws "Choose a model for <provider> first", so Pi's own per-provider default is never used.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins: { pi }, env, usage: usage({ stateDir, fetch }) })`, calls `add('pi', { piProvider })` per account, finishes sign-in through the fake `pi` binary, and reads `pick('pi').rows` (or the pool `list`) for each row's room and reset.
- `usage` hands `pick` the app's own `@byokit/usage` reader so its plans store and the account roster share one root; without it, `pick` builds one on `stateDir`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-pi.mjs"` importing `cliAccounts` from `@byokit/accounts/cli`, `{ usage }` from `@byokit/usage` and `{ fakeFetch }` from `@byokit/usage/testing`. Put the fake binaries and the state root under `"$scratch_dir"` and take it from `process.env.SCRATCH` (outside the worktree — see Gotchas). Write a fake `pi` binary (a `.cjs` Node script) that logs its argv and, for `auth check --provider <id> --json --no-refresh`, prints `{"status":"ready","provider":"<id>","authType":"oauth"}` and exits 0. Build `cliAccounts({ stateDir, bins: { pi }, env: { HOME, PATH: '/unused' }, usage: usage({ stateDir, fetch }) })` and add three rows: `openai-codex`, `kimi-coding` and a third Pi provider with no quota route (for example `github-copilot`). Write each signed-in account's own login into `join(folderOf(id), 'auth.json')`, keyed by its Pi provider id, as `{"<piProvider>":{"type":"oauth","access":"...","refresh":"...","expires":0,"accountId":"..."}}` (the `accountId` only the `openai-codex` row needs). Assert: each row is `ready`; `await usageSource(id)` is `{provider:'pi', folder, piProvider}` for the two routed rows and `undefined` for the third; the two folders differ; one `GET` per routed row to `chatgpt.com/backend-api/wham/usage` (with that row's `ChatGPT-Account-Id` and `Bearer`) and to `api.kimi.com/coding/v1/usages`; `pick('pi')` chooses the roomier row, ties keep list order, and each row's `room.left` is `100 - used_percent` (Kimi: `100 - 100 * (limit - remaining) / limit`) with its window's `resetsAt`; the unrouted row is `unknown` and no row is ever `0`. Then delete both `auth.json` files and assert `pick('pi')` still lists every row with `room.left === 'unknown'`. Print only token lengths, never a token.
- **Run and capture.** `feature=accounts-cli-pi; entry=@byokit/accounts/cli; drive=(env SCRATCH=<dir outside the worktree> node "$scratch_dir/verify-accounts-cli-pi.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `add: signing`, `status: ready`, `usage: source+codex`, `usage: source+undefined (no route)`, `usage: codex-40-left`, `usage: kimi-40-left`, `usage: pick+ties`, `usage: missing-unknown-never-zero`, `all lines passed`.
- **Missing and error cases show.** `usage: no-route -> unknown`, `usage: no-login -> unknown-never-zero`, and the unrouted row's `usageSource` printing `undefined`.
- **Proof.** The captured artifact contains those lines, the two request URLs with their own `ChatGPT-Account-Id`, and no token.

## Gotchas

- Import from `@byokit/accounts/cli` and `@byokit/usage`; never from `packages/*/src`.
- The consumer file has to sit where bare `@byokit/*` imports resolve, but the fake `pi` binary and the state root must sit outside the worktree: the worktree's `package.json` is `"type": module"`, so an extensionless fake binary there runs as ESM and its `require` fails. Give the fake a `.cjs` name, or use an outer `SCRATCH`.
- Pi's login argv is just `[bin]` and closing its TUI writes no completion marker: only `auth check --provider <id> --json --no-refresh` reports `status: ready` with `authType: oauth`, which is what makes the row `ready` and therefore readable.
- `pick` reads room only for a `ready` row, so a signed-out account sends no request.
- Never point `stateDir` (or a managed folder) at the owner's `~/.pi`; the kit never opens, seeds or copies Pi's own `auth.json`.
- Print only the token length; a token never reaches argv, env, a log or the evidence.
