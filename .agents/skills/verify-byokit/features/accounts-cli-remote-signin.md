# Remote agent-CLI sign-in state over a paired link

A host app driving the built `@byokit/accounts/cli` reports each agent CLI's installed/signed-in state and display payload shape without performing any sign-in, using fake native binaries plus one live read-only run against the real CLIs on this box.

## Sub-features

- `cli-remote-state`: `remoteCliState` names every CLI (`installed`, `signedIn`, `supported`, subscription `billing`) from status reads only — no roster or marker is written and no reply carries a credential.
- `cli-remote-display`: `remoteCliHost().start('codex')` relays only an `https` verification URL, the user code and the expiry; `wait` verifies through the kit's own `status` before reporting success.
- `cli-remote-unsupported`: `start('pi')` reports unsupported ("not supported here") and never spawns a Pi login; a missing binary reports missing.
- `cli-remote-managed-folder`: `cliAccounts({ managedFolders: { claude } })` points one Claude row at an app-owned folder inside `stateDir`; `remoteCliHost().start('claude')` runs the native login with `CLAUDE_CONFIG_DIR` set to that exact folder, a paste lands there, and `cancel` or `close()` removes only roster and marker bookkeeping, and a login whose status does not confirm keeps the login files its native CLI wrote (a canary in the folder survives). `close()` aborts the host's `signal`; a paste into a child that already closed its stdin is a plain `failed`, never a host crash.
- `cli-remote-live`: on this box, the real `claude`, `codex` and `pi` binaries report `installed=true` with isolated folders, and real status reads answer `signed_out` without touching the person's own logins.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins, env })` with app-owned absolute paths, wraps it in `remoteCliHost({ cli, bins })`, and a phone calls `remoteCliDevice(link).state()` / `start('codex')` over the paired link.
- The phone shows the verification URL and user code; the credential stays on the computer.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-remote.mjs"` importing `cliAccounts, remoteCliHost` from `@byokit/accounts/cli`. Build a fake `codex` binary (a Node script that answers `app-server` with `{ account }` once a `granted` file exists in `CODEX_HOME`, and answers `login --device-auth` by printing an `https` URL plus a `XXXX-XXXXX` code, then writing `granted`) in a `chmod 755` file. Start a Codex sign-in through `remoteCliHost`, assert the display has an `https` URL, a user code and a positive expiry, `wait` it to `{ ok: true }`, and assert `state()` names it signed in with the email label. Then drive the missing (`start` with no `codex` bin) and Pi-unsupported cases and print their `error` codes.
- **Managed folder leg.** In the same consumer, pass `managedFolders: { claude: "$stateDir/runtime/.claude" }` (pre-create it with a `canary` file) and a fake `claude` that prints an `https` address, takes one stdin line and writes `granted` into `CLAUDE_CONFIG_DIR`. `start('claude')`, `paste` the synthetic code, `wait` to `{ ok: true }`, and assert `granted` exists in that exact folder. Then `close()` and assert `signal.aborted` and that `canary` and `granted` are still there. Before that, a host whose fake child closes its stdin after printing the address must answer `paste` with `remoteCliProblem: 'failed'`, then `cancel` and `close()` cleanly.
- **Run and capture.** `feature=cli-remote-signin; entry=@byokit/accounts/cli; drive=(node "$scratch_dir/verify-accounts-cli-remote.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `display: https… + code + expiry`, `wait: ok`, `state: codex signedIn=true label=…`.
- **Missing and error cases show.** `missing code: missing`, `pi code: unsupported`.
- **Live read-only leg.** With the real `claude`/`codex`/`pi` binaries and a scratch `stateDir`, `remote.state()` prints `installed=true signedIn=false` for all three; after `add` plus a completion marker (the login itself never runs), real status reads answer `signed_out`; both rows are removed. No sign-in is performed and the person's own `~/.codex`/`~/.claude` are untouched.
- **Proof.** The captured artifact contains the display payload, the wait result, the signed-in state row, both error codes, the live leg's installed/signed-out lines with masked labels, and the final assertion line.

## Gotchas

- The kit never reads a real `~/.claude`, `~/.codex` or `~/.pi`: status spawns only the supplied absolute `bins` paths with the managed folder, so point `CODEX_HOME`/`CLAUDE_CONFIG_DIR` at scratch by construction.
- A login reads `ready` only after the host claims the `.byokit-signin-complete` marker and the CLI's own status confirms it; the host removes the marker and the row again when the status does not confirm.
- Replies carry only words and codes: assert no credential string appears in any reply JSON.
- The user code and verification URL travel only inside the sealed paired-link reply to the phone's display call; they never appear in state, wait results, failures or logs.
