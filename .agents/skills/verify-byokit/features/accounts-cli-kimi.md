# Managed Kimi Code CLI (two accounts)

A host app driving the built `@byokit/accounts/cli` adds two Kimi managed accounts, each with its own `KIMI_CODE_HOME` under `stateDir/kimi/<hex>`, finishes native `kimi login` via a fake binary (completion marker), launches with distinct folders and owner key overrides unset, resumes with `--session`, and removes one account without disturbing the other. The default-login guard refuses `~/.kimi-code` as `stateDir`. Fakes only: no real Kimi login, no owner folder read.

## Sub-features

- `cli-kimi-add-login`: `add('kimi')` returns `signing` with argv `[bin, 'login']` and `KIMI_CODE_HOME` set; shell exit 0 writes the completion marker and `status` becomes `ready`.
- `cli-kimi-two-accounts`: accounts A and B get different `KIMI_CODE_HOME` at launch; `KIMI_API_KEY` / `KIMI_CODE_CREDENTIALS` are unset; `remove(A)` leaves B ready.
- `cli-kimi-resume`: `resumeArgs('kimi', { kind:'id', value:'ses_1' })` is `['--session','ses_1']`; empty or dash-prefixed values throw `kind-mismatch`.
- `cli-kimi-default-login-guard`: `cliAccounts({ stateDir: join(HOME, '.kimi-code'), ... })` throws `bad-option`.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins: { kimi }, env })`, calls `add('kimi')` twice, runs each `signIn.shell`, then `launch` / `resumeArgs` / `remove`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-kimi.mjs"` importing `cliAccounts`, `CliAccountError` from `@byokit/accounts/cli`. Build a fake `kimi` binary that exits 0 on `login` and logs argv/env (`chmod 755`). Assert two-account isolation, resume args, remove(A) leaves B ready, and default-login guard. Print only pass lines.
- **Run and capture.** `feature=cli-kimi; entry=@byokit/accounts/cli; drive=(node "$scratch_dir/verify-accounts-cli-kimi.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `add: signing`, `login: ready`, `two: dirs-differ`, `resume: --session`, `remove-a: b-ready`, `guard: bad-option`.
- **Missing and error cases show.** resume dash-value / empty: `kind-mismatch`; stateDir under `~/.kimi-code`: `bad-option`.
- **Proof.** The captured artifact contains those lines.

## Gotchas

- Never point `stateDir` or a managed folder at the owner's `~/.kimi-code`.
- Never open `credentials/` under a Kimi home; readiness is the kit completion marker after `kimi login`.
