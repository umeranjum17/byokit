# Managed OpenCode CLI and plan-key route seam

A host app driving the built `@byokit/accounts/cli` adds an OpenCode managed account, saves a plan key into a Map-backed `@byokit/secrets` store with hidden typing (never argv/env/log), launches with `OPENCODE_CONFIG_DIR`, and reads the same key through `openCodeGoPlanAccount` from `@byokit/accounts/opencode-go`. Logout deletes the store entry. Fakes only: no live Go call, no real key.

## Sub-features

- `cli-opencode-add`: `add('opencode')` returns a `signing` row with empty `argv` and `instruction.words: 'cli.opencodeKey'`.
- `cli-opencode-saveKey-launch`: `saveKey` makes `status`/`launch` ready; launch sets `OPENCODE_CONFIG_DIR` and unsets `OPENCODE_API_KEY`; a canary key never appears in argv, env, state files, launch JSON or error text.
- `cli-opencode-route-seam`: `openCodeGoPlanAccount(store).access` reads the saved route entry and refuses with `Add the OpenCode plan key first.` when none is saved; `logout` deletes it.
- `cli-opencode-remote-readonly`: remote CLI state lists `opencode` as installed when binned, `supported: false`; `start('opencode')` returns `unsupported`.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins: { opencode }, env, keyStore })`, calls `add('opencode')`, `saveKey`, `launch`, then `openCodeGoPlanAccount(keyStore).access`, then `logout`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-opencode.mjs"` importing `cliAccounts` from `@byokit/accounts/cli` and `openCodeGoPlanAccount` from `@byokit/accounts/opencode-go`. Build a never-spawned fake `opencode` binary (`chmod 755`). Use a Map-backed `keyStore` and canary string `canary-opencode-plan-key-verify`. Assert add → missing-key refuse → saveKey → launch ok → access returns canary → logout → access refuses without canary in the message; assert remote `start('opencode')` is `unsupported`. Print only pass lines and error *codes*/words, never the canary.
- **Run and capture.** `feature=cli-opencode; entry=@byokit/accounts/cli; drive=(node "$scratch_dir/verify-accounts-cli-opencode.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`. After capture, `leak_check` the canary against `.verify-artifacts/cli-opencode/` and require exit 0.
- **Happy path shows.** `add: signing`, `saveKey: ready`, `launch: ok`, `route: access-ok`, `logout: signed_out`.
- **Missing and error cases show.** Before saveKey: `route: Add the OpenCode plan key first.`; remote: `unsupported`.
- **Proof.** The captured artifact contains those lines and no canary bytes (`leak_check` exit 0).

## Gotchas

- Pass `keyStore`; without it `saveKey` refuses `bad-option`.
- The plan key must never reach argv, env assignment, a state file, or evidence output.
- Remote sign-in stays unsupported: paste the key in the computer's app via `saveKey`.
