# Managed Vibe CLI (two accounts)

A host app driving the built `@byokit/accounts/cli` adds two Vibe managed accounts, each with its own `VIBE_HOME` under `stateDir/vibe/<hex>`, saves an API key via hidden `saveKey` into a Map-backed secrets store (never argv/env/log), launches with distinct folders and `MISTRAL_API_KEY` unset, resumes with `--resume`, and removes one account without disturbing the other. The default-login guard refuses `~/.vibe` as `stateDir`. Fakes only: no real Vibe login, no owner folder read.

## Sub-features

- `cli-vibe-add-key`: `add('vibe')` returns `signing` with empty `argv` and `instruction.words: 'cli.vibeKey'`; `saveKey` makes `status`/`launch` ready.
- `cli-vibe-two-accounts`: accounts A and B get different `VIBE_HOME` at launch; `MISTRAL_API_KEY` is unset; distinct `accounts.vibe:key.<id>` entries; `remove(A)` leaves B ready.
- `cli-vibe-resume`: `resumeArgs('vibe', { kind:'id', value:'ses_1' })` is `['--resume','ses_1']`; empty or dash-prefixed values throw `kind-mismatch`.
- `cli-vibe-default-login-guard`: `cliAccounts({ stateDir: join(HOME, '.vibe'), ... })` throws `bad-option`.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins: { vibe }, env, keyStore })`, calls `add('vibe')` twice with `saveKey`, then `launch` / `resumeArgs` / `remove`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-vibe.mjs"` importing `cliAccounts`, `CliAccountError`, `VIBE_API_KEY_ROUTE` from `@byokit/accounts/cli` and `openCodePlanKeyEntry`, `readOpenCodePlanKey` from `@byokit/accounts/opencode-go`. Build a never-spawned fake `vibe` binary (`chmod 755`). Use a Map-backed `keyStore` and canaries. Assert two-account isolation, resume args, remove(A) leaves B ready, and default-login guard. Print only pass lines; never print canaries.
- **Run and capture.** `feature=cli-vibe; entry=@byokit/accounts/cli; drive=(node "$scratch_dir/verify-accounts-cli-vibe.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`. After capture, `leak_check` each canary against `.verify-artifacts/cli-vibe/` and require exit 0.
- **Happy path shows.** `add: signing`, `saveKey: ready`, `two: dirs-differ`, `resume: --resume`, `remove-a: b-ready`, `guard: bad-option`.
- **Missing and error cases show.** resume dash-value / empty: `kind-mismatch`; stateDir under `~/.vibe`: `bad-option`.
- **Proof.** The captured artifact contains those lines and no canary bytes (`leak_check` exit 0).

## Gotchas

- Pass `keyStore`; without it `saveKey` refuses `bad-option`.
- Never point `stateDir` or a managed folder at the owner's `~/.vibe`.
- The API key must never reach argv, env assignment, a state file, or evidence output.
