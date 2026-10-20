# Managed CLI logins stay distinguishable

A host app driving the built `@byokit/accounts/cli` adds two managed Claude logins that answer with the same email, and reads each row's `addedAt` to tell the two apart without any credential or network read.

## Sub-features

- `cli-addedAt-present`: `add` returns a `signing` account whose `addedAt` is an epoch-millisecond number, and `list`/`status` expose the same value on every managed row.
- `cli-addedAt-distinct`: two logins added back to back, even in the same millisecond, come back with different `addedAt`, so two same-email logins are distinguishable.
- `cli-addedAt-persists`: the value is written to `accounts-v1.json` and survives a fresh `cliAccounts` instance.
- `cli-addedAt-derived`: a pre-existing roster row with no stored `addedAt` still exposes a numeric value derived from its folder metadata at read time, so it too is distinguishable and the roster bytes are left untouched.

## How to get to it (user POV)

- A Node app constructs `cliAccounts({ stateDir, bins: { claude }, env })` with app-owned absolute paths, calls `add('claude')` twice, marks each sign-in complete, and reads `list()`.
- Both native `auth status` answers name the same email; only `addedAt` separates the rows.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-cli-addedat.mjs"` importing `cliAccounts` from `@byokit/accounts/cli`. Build a fake `claude` binary (a Node script that answers `auth status` with `{ loggedIn: true, email: 'umer.work@example.test', planType: 'plus', subscriptionType: 'pro' }`) in a `chmod 755` file. `mkdir` the state dir's parent first (the kit refuses a missing parent). Add `claude` twice, write each `signIn.completion` at `0o600`, then `list()`. Assert one shared email, numeric `addedAt > 0`, and two different values; a fresh `cliAccounts` on the same state dir sees the same values. Then, in a second state dir, hand-write an `accounts-v1.json` holding two pre-existing `claude` rows that share the email and carry no `addedAt`, creating their `<stateDir>/claude/<hex>` folders in order: assert every `list()` row gets a numeric derived `addedAt`, the two derived values differ, and the roster bytes are unchanged. Finally catch `CliAccountError` from `status('pa_absent')` and print its `code`.
- **Run and capture.** `feature=cli-account-addedAt; entry=@byokit/accounts/cli; drive=(node "$scratch_dir/verify-accounts-cli-addedat.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `add first addedAt:`/`add second addedAt:` differ by at least one; `rows:` lists two ready rows with the same email and different `addedAt`; `distinct same-email logins: OK`.
- **Missing and error cases show.** `derived addedAt:` values differ, `roster untouched: true` for the pre-existing rows; `absent account code: unknown-account`.
- **Proof.** The captured artifact contains the two add values, the listed rows, the derived legacy values with the unchanged roster bytes, the caught error code, and the final assertion line.

## Gotchas

- The kit never reads a real `~/.claude`, `~/.codex` or `~/.pi`, and status spawns only the supplied absolute `bins` path; the fake binary must handle `auth status` and exit 0 otherwise.
- `stateDir` must be absolute with an existing real parent directory (not a symlink); create that parent before `cliAccounts`.
- A login reads `ready` only after its `.byokit-signin-complete` marker exists; without it the row stays `signing` and the identity is not read.
- `addedAt` is monotonic per instance, so two adds in the same millisecond still differ by one. A legacy roster row without `addedAt` derives one from its folder's `birthtimeMs` (or the earliest of `ctimeMs`/`mtimeMs`), so it stays distinguishable and the roster is not rewritten on load.
