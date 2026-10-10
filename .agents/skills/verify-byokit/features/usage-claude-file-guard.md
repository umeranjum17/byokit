# Usage Claude explicit-file default-login guard

A consumer app that hands `@byokit/usage` the exact Claude files it selected cannot be pointed, by accident or by a hostile path, at the person's own default Claude/Codex/Pi sign-in: any `credentialsFile`, `configFile` or `statuslineFile` carrying a `.claude`, `.codex` or `.pi` segment — lexically or once a symlink is resolved — is refused with a typed `UsageError` before any file is opened, while an app-owned file elsewhere still reads.

## Sub-features

- `usage-claude-file-guard-lexical`: a `credentialsFile` whose path itself has a `.claude`, `.codex` or `.pi` segment throws `UsageError` from `read`, `connected`, `account` and `lastKnown`, and the file is never opened.
- `usage-claude-file-guard-symlink`: an app-owned path that is a symlink into a default login is refused the same way.
- `usage-claude-file-guard-siblings`: a `configFile` or `statuslineFile` with a default-login segment is refused even when the `credentialsFile` is app-owned.
- `usage-claude-file-guard-app-owned`: an app-owned absolute file with no default-login segment still returns windows.

## How to get to it (user POV)

- The consumer imports `{ usage, UsageError }` from `@byokit/usage`, builds `usage({ stateDir, fetch })` with its own transport, and passes `{ provider: 'claude', credentialsFile, configFile?, statuslineFile? }`. The app owns sign-in and file selection; the kit only reads the files it is handed.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-usage-guard.mjs"` importing `{ usage, UsageError }` from `@byokit/usage`. In a scratch tree, make an `app/credentials.json` with a synthetic token, a `decoy/home/.claude/.credentials.json` with a synthetic token, and a symlink `app/link.json` → the decoy file. Build `usage({ stateDir: app/state, fetch })` with a counting `fetch` returning a canned Claude `five_hour` body. Then: read the app-owned file (expect one window); for each of the decoy path, the symlink, and the decoy passed as `configFile`/`statuslineFile`, call `read`/`connected`/`account`/`lastKnown` and print the caught error's `name` (expect `UsageError`); assert the fetch was called exactly once (the app-owned read only).
- **Run and capture.** `feature=usage-claude-file-guard; entry=@byokit/usage; drive=(node "$scratch_dir/verify-usage-guard.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Guard holds.** The app-owned read prints `windows 1`; every default-login call prints `UsageError`; the provider was called once, so no refused source reached the network.
- **Prove no open.** The same run (or `NODE_OPTIONS=--require` tracer) must show the decoy `.claude/.credentials.json` was never opened; the journey test's `traceFs` decoy-HOME block is the maintained proof of that.

## Gotchas

- Import from `@byokit/usage` (or the React Native entry); never from `packages/usage/src`.
- The guard is lexical plus realpath: a symlink is refused even when its own path looks app-owned, so an app cannot alias a default login.
- This is a refusal, not a fallback: the source throws `UsageError`; it never silently reads something else.
- No server to clean up — use SKILL.md Cleanup to remove only "$scratch_dir" and confirm the captured evidence survives.
