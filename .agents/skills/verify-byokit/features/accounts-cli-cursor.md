# Managed Cursor CLI (two accounts)

A host app driving the built `@byokit/accounts/cli` adds two Cursor managed accounts, each with its own `XDG_CONFIG_HOME` under `stateDir/cursor/<hex>`, finishes native `cursor-agent login` via a fake binary, reads readiness from `cursor-agent status --format json` `isAuthenticated` (the command exits 0 even when signed out), launches with both folder variables (`XDG_CONFIG_HOME` and `CURSOR_CONFIG_DIR`), `GH_CONFIG_DIR` and `GIT_CONFIG_GLOBAL` pointing at the pool HOME's real files, resumes with `--resume`, and removes one account without disturbing the other. A real `git commit` in a scratch repo under the managed folder succeeds with the launch environment whether the pool HOME's identity lives in `<HOME>/.config/git/config` or in `<HOME>/.gitconfig`, and the same commit is refused with exit 128 when `GIT_CONFIG_GLOBAL` is pinned to the missing XDG file. Fakes only: the owner's `~/.config/cursor/auth.json` is never read or copied.

## Sub-features

- `cli-cursor-add-login`: `add('cursor')` returns `signing` with argv `[bin, 'login']` and `XDG_CONFIG_HOME` set; shell exit 0 writes the kit completion marker and `status` becomes `ready`.
- `cli-cursor-two-accounts`: accounts A and B get different `XDG_CONFIG_HOME` folders and different `<folder>/cursor/auth.json` bytes; deleting A's own login leaves A `signed_out` while B stays `ready`; `remove(A)` leaves B ready.
- `cli-cursor-status-json`: `status` runs `status --format json` against that account's folder and follows `isAuthenticated` — `false` is `signed_out` while the process exits 0, `true` with a non-zero exit is still `ready`, and malformed output is `signed_out`.
- `cli-cursor-launch-env`: `launch` `set` carries `XDG_CONFIG_HOME` and `CURSOR_CONFIG_DIR` naming the same managed folder plus `GH_CONFIG_DIR` (`<env.HOME>/.config/gh`); `GIT_CONFIG_GLOBAL` names the pool HOME's own global git file (`<env.HOME>/.gitconfig` when present, else `<env.HOME>/.config/git/config`, absent when it has neither); an ambient `CURSOR_CONFIG_DIR` never reaches a spawn; `unset` carries `CURSOR_API_KEY` and `CURSOR_AUTH_TOKEN`, and `GIT_CONFIG_GLOBAL` when no file was named.
- `cli-cursor-git-commit`: with that launch environment a real `git commit` in a scratch repo inside the managed folder exits 0 and records the pool HOME's real author identity from either global file layout; with only `<HOME>/.gitconfig` present, pinning `GIT_CONFIG_GLOBAL` to the missing XDG file exits 128 (`Author identity unknown`).
- `cli-cursor-resume`: `resumeArgs('cursor', { kind:'id', value:'chat_1' })` is `['--resume','chat_1']`; empty, dash-prefixed or `path` values throw `kind-mismatch`.
- `cli-cursor-default-login-guard`: `cliAccounts({ stateDir: join(HOME, '.config', 'cursor'), ... })` throws `bad-option`, and so does a `stateDir` whose own tool folder would be that login, such as `join(HOME, '.config')`.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins: { cursor }, env })`, calls `add('cursor')` twice, runs each `signIn.shell`, then `launch` / `resumeArgs` / `remove`; it applies `launch.set` and `launch.unset` before starting `cursor-agent` in that folder.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-cursor.mjs"` importing `cliAccounts`, `CliAccountError` from `@byokit/accounts/cli`. Build a fake `cursor-agent` binary that on `login` writes `<XDG_CONFIG_HOME>/cursor/auth.json` naming its own folder and exits 0, and on `status --format json` prints `{status, isAuthenticated, hasAccessToken, hasRefreshToken}` from that file's presence and exits 0 (a `CURSOR_STATUS_MODE=signed-in-nonzero-exit` run exits 1 while still printing `true`). Give the scratch HOME a real global git file and drive all three layouts: first `HOME/.config/git/config`, then only `HOME/.gitconfig`, then neither. Assert: two distinct folders and differing auth bytes, A signed out while B ready, `status` JSON precedence, the `set` names (`XDG_CONFIG_HOME` and `CURSOR_CONFIG_DIR` both the folder, `GH_CONFIG_DIR`, and `GIT_CONFIG_GLOBAL` only in the two layouts that have a file) and the `unset` names (the two provider overrides, plus `GIT_CONFIG_GLOBAL` in the layout with no file), an ambient `CURSOR_CONFIG_DIR` replaced, a real `git -c user.useConfigOnly=true commit` that exits 0 and whose `%ae` is the configured address in each layout that has a file, plus exit 128 when `GIT_CONFIG_GLOBAL` is pinned to the missing XDG file, `--resume`, and the `~/.config/cursor` guard including its parent `~/.config`.
- **Run and capture.** `feature=cli-cursor; entry=@byokit/accounts/cli; drive=(node "$scratch_dir/verify-accounts-cli-cursor.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `add: signing`, `login argv: cursor-agent login`, `login: ready (…)`, `two: dirs-differ`, `two: bytes-differ`, `launch: xdg+cursor-config+gh`, `unset: key+token`, `spawn env: overrides gone`, `kinds: cursor only`, `room: unknown source`, `git: commit-ok (xdg)`, `git: commit-ok (gitconfig)`, `git: no-global -> unset-only`, `status-json: signed-out-while-exit-0`, `resume: --resume`, `remove-a: b-ready`, `guard: bad-option`, `guard: parent bad-option`, `all lines passed`.
- **Missing and error cases show.** `git: missing-global -> 128`, `status-json: true-on-nonzero-exit -> ready`, `status-json: malformed -> signed-out`, `resume: kind-mismatch`.
- **Proof.** The captured artifact contains those lines.

## Gotchas

- `cursor-agent status` exits 0 when signed out: only the JSON's `isAuthenticated` decides, never the exit code.
- Never point `stateDir` (or a `stateDir` whose tool folder would land there) at the owner's `~/.config/cursor`.
- The scratch consumer's runtime root sits under the worktree, whose `package.json` is `"type": "module"`: a fake native binary there must end in `.cjs` (or be ESM), or node refuses its `require`.
- `XDG_CONFIG_HOME` decides the login folder and `CURSOR_CONFIG_DIR` is Cursor's other documented config override: the launch moves both to the one managed folder, so neither can point two accounts at one config.
- The folder's own `git/config` is not written: a moved `XDG_CONFIG_HOME` hides the pool HOME's global git file unless `GIT_CONFIG_GLOBAL` names it, and `GIT_CONFIG_GLOBAL` replaces git's whole global set, so it must name the file that exists (`~/.gitconfig` wins when both do) and stay unset when there is none.
