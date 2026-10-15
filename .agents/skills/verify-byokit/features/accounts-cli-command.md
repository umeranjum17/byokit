# The `byokit-accounts` command

A person who keeps several agent-CLI accounts gets one list to read and one switch to use, without any of that state living anywhere else. The package's `byokit-accounts` bin prints JSON rows for every account of every tool (`id`, `tool`, `name`, `state`, `restUntil`, `why`, `room`, `windows`, `readAt`, `stale`, `preferred`) or a plain aligned table, answers `pick` for one tool with the account a launch should start on plus its `set`/`unset`, answers `list --json --cached` from a saved reading with no read at all, keeps a tool's chosen account in `prefer-v1.json` for `use`/`use --clear`, and prints folder-path `export`/`unset` lines for `eval "$(byokit-accounts env <id>)"`; it adds, reads, rests and un-rests accounts through the same `cliAccounts` functions the fleet calls, so the list and the pick can never disagree.

## Sub-features

- `cli-command-package`: an installed tarball exposes `bin.byokit-accounts=dist/accounts-cli.js`, includes that target with its Node shebang, and `npm exec -- byokit-accounts --help` exits 0 with usage before any pool or sign-in exists.
- `cli-command-list`: `list --json` prints one row per account of every tool, each with its reading; a Codex row carries the fake app-server's room, a row whose managed folder holds no Claude credential reads `unknown` without a request, and no native output (here a canary token) appears in a row. A fresh reading is `stale: false`; a row with no `readAt` is `stale: true`; `preferred` is absent until `use` names one.
- `cli-command-table`: `list` with no `--json` prints the aligned `id tool name state room reset note` table, one line per account, says `preferred` in words on exactly the stored row, carries no colour code and no secret.
- `cli-command-cached`: `list`/`pick` save the last reading of every row whole to `readings-v1.json` (0600); `list --json --cached` prints exactly those rows with the reader's binary replaced by a marker script that is never run, while a live list does run it.
- `cli-command-use`: `use <id>` stores `<tool> -> <id>` in `prefer-v1.json` (0600), `pick` then returns that account while it is ready, a stored account that rests falls back to the normal order, `use --clear <tool>` ends the preference, and a clear for a tool with no entry succeeds changing nothing.
- `cli-command-env`: `env <id>` prints `export <folder var>='<path>'` and `unset <credential override>` lines with folder paths only; a real `/bin/sh` `eval` of its output sets the folder variable and unsets the override, with the tool's binary moved away so no reader can run.
- `cli-command-pick`: `pick <tool> --json` names that tool's chosen account, its `room`, its `windows`, its `readAt` and the `set`/`unset` a launch applies; its `rows` are the same rows `list` shows for that tool.
- `cli-command-none`: a tool with no candidate exits 1, prints `{ ok: false, reason, rows }` and one plain sentence on stderr, and still lists the resting row.
- `cli-command-rests`: `rest <id> --until <epoch|ISO|45m> --why <text>` persists the B1 rest (`rests-v1.json`, 0600) and reads back `resting` with `restUntil`; `unrest <id>` returns it to `ready`; an unknown id is a plain message, empty stdout and exit 1.
- `cli-command-prepare`: `add <tool>` shares only the plan's names from the person's own default folder — Claude links `skills/` (the person's own link target) and `agents/` and copies `settings.json`, leaves BYOKit's own `projects` history link alone, and never brings `.credentials.json`, `.claude.json`, `auth.json`, `trust.json`, a session store, a log or `models.json` into the new folder (0700).
- `cli-command-pool`: pool commands require the config described in [the command reference](../../../../packages/accounts/README.md#the-byokit-accounts-command); standalone `--help` must succeed without it.

## How to get to it (user POV)

- Build the package and write the pool config once: `<stateDir>/pool.json` with `bins` (absolute paths from `command -v`), `home` and `path`.
- `node packages/accounts/dist/accounts-cli.js list --state <dir>` shows the plain table; add `--json` for the rows, or `--json --cached` for the saved reading with no read.
- `… add claude --state <dir>` prints `{ account, signIn }` and the shell to run next; `… pick codex --json --state <dir>` is what a spawn hook calls.
- `… use <id> --state <dir>` makes that account the tool's pick; `… use --clear codex --state <dir>` ends it.
- `eval "$(node packages/accounts/dist/accounts-cli.js env <id> --state <dir>)"` sets the tool's folder variable in that shell.
- `… rest <id> --until 45m --state <dir>` keeps the fleet off an account; `… unrest <id> --state <dir>` puts it back.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), and `npm run build` so `packages/accounts/dist/accounts-cli.js` exists.

- **Prove executable packaging for a release.** After building, `npm pack ./packages/accounts --pack-destination <evidence-dir> --json`; inspect `package/package.json` and `package/dist/accounts-cli.js` in that actual tarball for the bin mapping and `#!/usr/bin/env node`. In an exclusive short scratch project outside the workspace, with a throwaway HOME, empty npm userconfig and task-owned cache, install the tarball with `npm install --no-audit --no-fund <absolute-tarball>`, then run `npm exec -- byokit-accounts --help`. Retain the pack manifest, tarball hash, installed version, stdout/stderr and exit code. No `--state` or sign-in is needed. After trusted publication, repeat with a fresh HOME/cache using `npx -p @byokit/accounts@latest byokit-accounts --help`, retaining the resolved registry version and released tarball hash; a merged bump is not publication proof. Remove the scratch project/cache, not the evidence.
- **Run the maintained capture.** `feature=accounts-cli-command; entry=packages/accounts/dist/accounts-cli.js; drive=(node .agents/skills/verify-byokit/capture/accounts-cli-command.mjs)`, then SKILL.md Evidence's capture block. Exit code `0`.
- **What the capture does.** It resolves the built bin through the workspace, writes a throwaway pool (`pool.json` with a fake `claude`, a `fakeCodex({ dir })` app-server and a stub `pi`) and a person HOME with the usual Claude/Codex config, then runs the real bin as a child process: `add claude`, `add codex` twice, `list --json`, `list`, `pick codex --json`, `use`, `rest`/`unrest`, `pick` with no candidate, `status <id>`, `use --clear`, `env` through `/bin/sh`, `list --json --cached`, a wrong id, and the prepare assertions on the new folder.
- **What the output shows.** `cli-command-help:` usage with exit 0 and no pool, `cli-command-prepare:` the new folder's names (0700, no sign-in file), `cli-command-list:` each tool's state/room/window count with `private-fake-token` absent, `cli-command-pick:` the chosen id and its `set` keys, `cli-command-rest:`, `cli-command-none:`, `cli-command-unrest:`, `cli-command-unknown:`, `cli-command-use:`, `cli-command-table:` the table itself, `cli-command-use-clear:`, `cli-command-env:` the shell's readback, `cli-command-cached:`.
- **Offline test.** `sh scripts/test.sh packages/accounts/test/cli-command.test.ts` drives the same bin from `src/accounts-cli.ts` in a throwaway HOME (no account, no egress).

## Gotchas

- The bin answers JSON by default; `list` with no `--json` prints the plain table and `env` prints shell `export`/`unset` lines instead — both carry folder paths and plain words only, never a secret.
- The state root and the fake CLIs must sit outside the worktree when a test spawns them: the worktree's `type: module` makes an extensionless fake CLI run as ESM, where `fakeCodex`'s `require` fails.
- `pool.json` carries binary paths, `HOME` and `PATH` only; an account's own folder, roster, rests stay in the state root, and `readings-v1.json` holds rows while `prefer-v1.json` holds `<tool> -> <id>` — neither can hold a credential.
- `--cached` never runs a reader: replacing the tool's binary leaves the cached rows byte-identical, while a live list runs it.
- A stored `use` account wins only while it is `ready` and not resting; a rest, a sign-out or an unknown room falls back to the existing order, so a stored id is a preference, never a promise.
- Claude room needs a readable `.credentials.json` inside the managed folder; without one the row is `unknown`, which is what the capture asserts (no credential is copied into a pool folder).
- `pick` reads once per candidate through `@byokit/usage`; a later `list` inside the freshness floor reuses that reading, so the two agree without a second request.
