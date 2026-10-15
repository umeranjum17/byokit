# Managed OpenCode CLI and plan-key route seam

A host app driving the built `@byokit/accounts/cli` adds an OpenCode managed account, saves a plan key into a Map-backed `@byokit/secrets` store with hidden typing (never argv/env/log), launches with `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG=<folder>/opencode.json`, and reads that account's key through `readOpenCodePlanKey(..., accountId)`. Two accounts keep distinct store entries and config dirs. Launch writes the key to `<folder>/go.key` (0600, folder 0700) and references it via `{file:}` in the config; logout/remove delete the delivery copies and that account's entry. The host supplies an OpenCode auth/data store with no console account; config-dir isolation alone is insufficient. `resumeArgs('opencode', { kind: 'id' })` returns `--session`. The portable `openCodeGoPlanAccount` route-only entry stays separate. Fakes only: no live Go call, no real key.

## Sub-features

- `cli-opencode-add`: `add('opencode')` returns a `signing` row with empty `argv` and `instruction.words: 'cli.opencodeKey'`.
- `cli-opencode-saveKey-launch`: `saveKey` makes `status`/`launch` ready; launch sets `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG`, unsets `OPENCODE_API_KEY`, writes the 0600 delivery files under a 0700 folder. Spawn a real Node consumer selecting an `opencode-go/<model>` model and resolving `config.provider['opencode-go'].options.apiKey`; assert its argv/env contain no key bytes. Logout/remove delete both files. Only `go.key` contains key bytes; launch JSON, config, errors and evidence do not.
- `cli-opencode-route-seam`: managed `saveKey` writes `accounts.<route>:<accountId>`; the first managed row claims the old route-only key only without an account key, leaving other rows unsigned even after its removal. Existing colon/dot account keys preserve an independent portable route key through status, launch, usageSource, logout/remove, restart, sign-in-again and later rows. Previous dot-separated account entries remain readable and are deleted on logout. Ollama Pro's shared route-only seam is unchanged.
- `cli-opencode-usage`: `await usageSource(id)` returns `{provider:'opencode', key}` for each saved account, undefined without a key; never print the result.
- `cli-opencode-two-accounts`: add A/`saveKey(A)`, add B/`saveKey(B)` → distinct store entries and canaries; `remove(A)` leaves B ready with its key; `launch(A)`/`launch(B)` set different `OPENCODE_CONFIG_DIR`; `resumeArgs('opencode', { kind:'id', value:'ses_1' })` is `['--session','ses_1']`; a value starting with `-` still throws `kind-mismatch`.
- `cli-opencode-remote-readonly`: remote CLI state lists `opencode` as installed when binned, `supported: false`; `start('opencode')` returns `unsupported`.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins: { opencode }, env, keyStore })`, calls `add('opencode')`, `saveKey`, `launch`, then a second account for isolation, then `resumeArgs`, then `logout`/`remove`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-opencode.mjs"` importing `cliAccounts` from `@byokit/accounts/cli` and `openCodeGoPlanAccount`, `OPENCODE_GO_PLAN_ROUTE`, `readOpenCodePlanKey` from `@byokit/accounts/opencode-go`. Build a never-spawned fake `opencode` binary (`chmod 755`). Use a Map-backed `keyStore` and canaries `canary-opencode-plan-key-verify` / `canary-A-oc-two` / `canary-B-oc-two`. Assert add → missing-key refuse → saveKey → launch ok → per-account `readOpenCodePlanKey` returns canary → logout → access refuses without canary in the message; assert remote `start('opencode')` is `unsupported`. Drive the two-account journey (distinct colon entries, remove A, different `OPENCODE_CONFIG_DIR`, resumeArgs), folder-delivery subprocess selecting `opencode-go/<model>` through the matching provider binding, independent portable-key preservation across managed reads and deletion (both colon/dot keys), restart/sign-in-again and later-row isolation, file modes and logout/remove cleanup, per-account usage source, first-row-only route migration without reassignment after removal, and previous dot-entry compatibility. Print only pass lines and error *codes*/words, never the canaries.
- **Run and capture.** `feature=cli-opencode; entry=@byokit/accounts/cli; drive=(node "$scratch_dir/verify-accounts-cli-opencode.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`. After capture, `leak_check` each canary against `.verify-artifacts/cli-opencode/` and require exit 0.
- **Happy path shows.** `add: signing`, `saveKey: ready`, `launch: ok`, `account: access-ok`, `logout: signed_out`, `two: ready`, `two: dirs-differ`, `resume: --session`, `remove-a: b-ready`.
- **Missing and error cases show.** Before saveKey: `account: Add the OpenCode plan key first.`; remote: `unsupported`; resume dash-value: `kind-mismatch`.
- **Proof.** The captured artifact contains those lines and no canary bytes (`leak_check` exit 0).

## Gotchas

- Pass `keyStore`; without it `saveKey` refuses `bad-option`.
- The plan key must never reach argv, env assignment, any state file except `go.key`, or evidence output.
- Managed CLI keys are per account id; portable `openCodeGoPlanAccount` is still one entry per route.
- Remote sign-in stays unsupported: paste the key in the computer's app via `saveKey`.
