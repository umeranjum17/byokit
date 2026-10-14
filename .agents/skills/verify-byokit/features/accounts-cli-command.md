# The `byokit-accounts` command

A person who keeps several agent-CLI accounts gets one list to read and one switch to use, without any of that state living anywhere else. The package's `byokit-accounts` bin prints JSON rows for every account of every tool (`id`, `tool`, `name`, `state`, `restUntil`, `why`, `room`, `windows`, `readAt`) and answers `pick` for one tool with the account a launch should start on plus its `set`/`unset`; it adds, reads, rests and un-rests accounts through the same `cliAccounts` functions the fleet calls, so the list and the pick can never disagree.

## Sub-features

- `cli-command-list`: `list --json` prints one row per account of every tool, each with its reading; a Codex row carries the fake app-server's room, a row whose managed folder holds no Claude credential reads `unknown` without a request, and no native output (here a canary token) appears in a row.
- `cli-command-pick`: `pick <tool> --json` names that tool's chosen account, its `room`, its `windows`, its `readAt` and the `set`/`unset` a launch applies; its `rows` are the same rows `list` shows for that tool.
- `cli-command-none`: a tool with no candidate exits 1, prints `{ ok: false, reason, rows }` and one plain sentence on stderr, and still lists the resting row.
- `cli-command-rests`: `rest <id> --until <epoch|ISO|45m> --why <text>` persists the B1 rest (`rests-v1.json`, 0600) and reads back `resting` with `restUntil`; `unrest <id>` returns it to `ready`; an unknown id is a plain message, empty stdout and exit 1.
- `cli-command-prepare`: `add <tool>` shares only the plan's names from the person's own default folder — Claude links `skills/` (the person's own link target) and `agents/` and copies `settings.json`, leaves BYOKit's own `projects` history link alone, and never brings `.credentials.json`, `.claude.json`, `auth.json`, `trust.json`, a session store, a log or `models.json` into the new folder (0700).
- `cli-command-pool`: every command reads `<stateDir>/pool.json` for the tool binary paths, `HOME` and `PATH`, and is named by `--state <dir>`.

## How to get to it (user POV)

- Build the package and write the pool config once: `<stateDir>/pool.json` with `bins` (absolute paths from `command -v`), `home` and `path`.
- `node packages/accounts/dist/accounts-cli.js list --json --state <dir>` shows every account and its room.
- `… add claude --state <dir>` prints `{ account, signIn }` and the shell to run next; `… pick codex --json --state <dir>` is what a spawn hook calls.
- `… rest <id> --until 45m --state <dir>` keeps the fleet off an account; `… unrest <id> --state <dir>` puts it back.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), and `npm run build` so `packages/accounts/dist/accounts-cli.js` exists.

- **Run the maintained capture.** `feature=accounts-cli-command; entry=packages/accounts/dist/accounts-cli.js; drive=(node .agents/skills/verify-byokit/capture/accounts-cli-command.mjs)`, then SKILL.md Evidence's capture block. Exit code `0`.
- **What the capture does.** It resolves the built bin through the workspace, writes a throwaway pool (`pool.json` with a fake `claude`, a `fakeCodex({ dir })` app-server and a stub `pi`) and a person HOME with the usual Claude/Codex config, then runs the real bin as a child process: `add claude`, `add codex`, `list --json`, `pick codex --json`, `rest <id> --until 45m`, `pick` with no candidate, `unrest <id>`, `status <id>`, a wrong id, and the prepare assertions on the new folder.
- **What the output shows.** `cli-command-prepare:` the new folder's names (0700, no sign-in file), `cli-command-list:` each tool's state/room/window count with `private-fake-token` absent, `cli-command-pick:` the chosen id and its `set` keys, `cli-command-rest:`, `cli-command-none:`, `cli-command-unrest:`, `cli-command-unknown:`.
- **Offline test.** `sh scripts/test.sh packages/accounts/test/cli-command.test.ts` drives the same bin from `src/accounts-cli.ts` in a throwaway HOME (no account, no egress).

## Gotchas

- The bin always answers JSON; `--json` is accepted and is the only format today (the table view is a later lane).
- The state root and the fake CLIs must sit outside the worktree when a test spawns them: the worktree's `type: module` makes an extensionless fake CLI run as ESM, where `fakeCodex`'s `require` fails.
- `pool.json` carries binary paths, `HOME` and `PATH` only; an account's own folder, roster and rests stay in the state root, and answer text never contains a credential.
- Claude room needs a readable `.credentials.json` inside the managed folder; without one the row is `unknown`, which is what the capture asserts (no credential is copied into a pool folder).
- `pick` reads once per candidate through `@byokit/usage`; a later `list` inside the freshness floor reuses that reading, so the two agree without a second request.
