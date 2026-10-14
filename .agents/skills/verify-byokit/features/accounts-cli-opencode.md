# Managed OpenCode CLI and plan-key route seam

A host app driving the built `@byokit/accounts/cli` adds an OpenCode managed account, saves a plan key into a Map-backed `@byokit/secrets` store with hidden typing (never argv/env/log), launches with `OPENCODE_CONFIG_DIR`, and reads that account's key through `readOpenCodePlanKey(..., accountId)`. Two accounts keep distinct store entries and config dirs. Logout/remove deletes only that account's entry. `resumeArgs('opencode', { kind: 'id' })` returns `--session`. The portable `openCodeGoPlanAccount` route-only entry stays separate. Fakes only: no live Go call, no real key.

## Sub-features

- `cli-opencode-add`: `add('opencode')` returns a `signing` row with empty `argv` and `instruction.words: 'cli.opencodeKey'`.
- `cli-opencode-saveKey-launch`: `saveKey` makes `status`/`launch` ready; launch sets `OPENCODE_CONFIG_DIR` and unsets `OPENCODE_API_KEY`; a canary key never appears in argv, env, state files, launch JSON or error text.
- `cli-opencode-route-seam`: managed `saveKey` writes `accounts.<route>.<accountId>`; portable `openCodeGoPlanAccount(store)` still uses the route-only entry and refuses with `Add the OpenCode plan key first.` when none is saved; `logout` deletes only the managed account entry.
- `cli-opencode-two-accounts`: add A/`saveKey(A)`, add B/`saveKey(B)` → distinct store entries and canaries; `remove(A)` leaves B ready with its key; `launch(A)`/`launch(B)` set different `OPENCODE_CONFIG_DIR`; `resumeArgs('opencode', { kind:'id', value:'ses_1' })` is `['--session','ses_1']`; a value starting with `-` still throws `kind-mismatch`.
- `cli-opencode-remote-readonly`: remote CLI state lists `opencode` as installed when binned, `supported: false`; `start('opencode')` returns `unsupported`.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins: { opencode }, env, keyStore })`, calls `add('opencode')`, `saveKey`, `launch`, then a second account for isolation, then `resumeArgs`, then `logout`/`remove`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-opencode.mjs"` importing `cliAccounts` from `@byokit/accounts/cli` and `openCodeGoPlanAccount`, `OPENCODE_GO_PLAN_ROUTE`, `readOpenCodePlanKey` from `@byokit/accounts/opencode-go`. Build a never-spawned fake `opencode` binary (`chmod 755`). Use a Map-backed `keyStore` and canaries `canary-opencode-plan-key-verify` / `canary-A-oc-two` / `canary-B-oc-two`. Assert add → missing-key refuse → saveKey → launch ok → per-account `readOpenCodePlanKey` returns canary → logout → access refuses without canary in the message; assert remote `start('opencode')` is `unsupported`. Drive the two-account journey (distinct entries, remove A, different `OPENCODE_CONFIG_DIR`, resumeArgs). Print only pass lines and error *codes*/words, never the canaries.
- **Run and capture.** `feature=cli-opencode; entry=@byokit/accounts/cli; drive=(node "$scratch_dir/verify-accounts-cli-opencode.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`. After capture, `leak_check` each canary against `.verify-artifacts/cli-opencode/` and require exit 0.
- **Happy path shows.** `add: signing`, `saveKey: ready`, `launch: ok`, `account: access-ok`, `logout: signed_out`, `two: ready`, `two: dirs-differ`, `resume: --session`, `remove-a: b-ready`.
- **Missing and error cases show.** Before saveKey: `account: Add the OpenCode plan key first.`; remote: `unsupported`; resume dash-value: `kind-mismatch`.
- **Proof.** The captured artifact contains those lines and no canary bytes (`leak_check` exit 0).

## Gotchas

- Pass `keyStore`; without it `saveKey` refuses `bad-option`.
- The plan key must never reach argv, env assignment, a state file, or evidence output.
- Managed CLI keys are per account id; portable `openCodeGoPlanAccount` is still one entry per route.
- Remote sign-in stays unsupported: paste the key in the computer's app via `saveKey`.
