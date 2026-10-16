# Managed CLI account pick

A pool owner asks one function which managed CLI account a run should start on, and reads the same rows a pool view lists. `pick(provider, { prefer? })` considers only that tool's `ready`, not-resting rows, lets `prefer` win while it is ready, then takes the most room left — reading real room from `@byokit/usage` for Claude (`{folder, headers}`), Codex (`usageSource`), Cursor and Pi (`usageSource`), unknown for a tool a later lane adds — and returns every row with its reading so a list shows the same numbers.

## Sub-features

- `cli-pick-room`: the `ready` row with the most room left wins, and its `room.left` matches `roomOf` over the normalized windows.
- `cli-pick-prefer`: `prefer` names the chosen account while that account is ready; a resting or signed-out preferred account does not win and is skipped like any other.
- `cli-pick-skip`: a resting row and a signed-out row are never candidates, and neither row is read.
- `cli-pick-unknown`: a row with no readable room ranks after a row with a known room; when every candidate is unknown, list order decides.
- `cli-pick-none`: a tool with no candidate returns `{ ok: false, code: 'none', reason, rows }` and still lists every row.
- `cli-pick-rows`: rows carry `{ account, room, windows, readAt? }` only, with no secret.

## How to get to it (user POV)

- The consumer imports `cliAccounts` from `@byokit/accounts/cli`, adds one or more managed accounts per tool, and calls `accounts.pick('claude')`.
- Room needs `claudeHeaders: { 'anthropic-beta', 'User-Agent' }` for Claude rows and the Codex executable in `bins`; `usage` may hand `pick` the app's own `@byokit/usage` reader.
- `accounts.list()` answers the roster; `pick(...).rows` is the same roster with readings, so a pool view and the fleet agree.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-cli-pick.mjs"` importing `{ cliAccounts }` from `@byokit/accounts/cli`, `{ usage }` from `@byokit/usage` and `{ fakeCodex, fakeFetch }` from `@byokit/usage/testing`. Take the state root from `process.env.SCRATCH` and keep it *outside* the worktree (see Gotchas). In it: write a fake `claude` executable (a Node script that prints `{"loggedIn":true,...}` for `auth status` unless its `CLAUDE_CONFIG_DIR` holds a `signed-out` file), a `fakeCodex({ dir })` raw with `account` plus a `rateLimitsByLimitId.codex.primary`, and a `fakeFetch` queue with one Claude `{five_hour:{used_percentage:N}}` body per Claude account. Build `cliAccounts({ stateDir, bins: { claude, codex }, env: { HOME, PATH: '/unused' }, claudeHeaders, usage: usage({ stateDir, fetch }) })`. For each account, `add(provider)` then write `.byokit-signin-complete` into `launchEnv(id).set.CLAUDE_CONFIG_DIR`/`CODEX_HOME`, plus a synthetic `.credentials.json` (`claudeAiOauth.accessToken`, `expiresAt`) for Claude rows. Then print `pick('claude')`'s chosen id, each row's `[id, state, room.left]`, the request count and URLs, `pick('claude', { prefer: <thin id> })`'s chosen id, the same after `rest(<roomiest>)`, after a `signed-out` marker, and the `none` result after resting every candidate; assert no row text carries the synthetic token.
- **Run and capture.** `feature=accounts-cli-pick; entry=@byokit/accounts/cli; drive=(env SCRATCH=<dir outside the worktree> node "$scratch_dir/verify-cli-pick.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What the output shows.** Most room wins; `prefer` wins over more room; the resting, signed-out and unknown rows are skipped or ranked last; `none` lists every row; the two Claude usage requests carry the app's two headers at `api.anthropic.com/api/oauth/usage`.

## Gotchas

- Import from `@byokit/accounts/cli` and `@byokit/usage`; never from `packages/*/src`.
- The consumer file has to sit inside the worktree so bare `@byokit/*` imports resolve, but its state root must not: the worktree's `type: module` makes an extensionless fake CLI run as ESM, so `fakeCodex`'s `require` fails and every Codex row reads signed out. Put `SCRATCH` (state dir and fake binaries) outside the worktree, or give a hand-written fake a `.cjs` name.
- Claude room needs the app's `claudeHeaders`; with no headers the row is unknown, never zero.
- A fake Codex app-server must answer both requests with one raw body: `account` makes the row ready, `rateLimitsByLimitId` makes its room.
- `pick` reads room only for a `ready` row, so a signed-out account sends no request.
- No server to clean up — use SKILL.md Cleanup to remove only "$scratch_dir" and confirm the captured evidence survives.
