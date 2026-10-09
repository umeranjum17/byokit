# OpenClaw install drift diagnostics

Verification recipe for the retained install-drift diagnosis in [`@byokit/openclaw`](../../../../packages/openclaw/README.md)
(`Engine.prepare`/`installMatches`, 5.4/5.16). When an engine install or post-build verification fails, the kit
retains a size-capped, environment-free record at `<stateDir>/logs/engine-install-drift.json` before the failed
temporary set is deleted, so a natural `drift-after-build` failure can still be diagnosed after its temp is gone.

## Sub-features

- The record carries the first failed root-manifest or package check: its path, expected vs actual version (or the
  read error), never a bare boolean.
- The record carries the npm path and version and the npm stderr tail (capped), including the stderr of the
  npm run that had exited 0 before verification failed.
- A non-comparator failure (for example build-info drift) retains the npm facts with `firstFailedCheck: null`.
- The failed temporary tree is still deleted; only the diagnosis outlives it. Fields are bounded (stderr tail 500,
  read error 300) and the file contains no environment values or secrets.

## How to get to it (user POV)

An app calls `kit.prepare()` (directly or through `start()`). If the pinned engine's install or the verification
right after it fails, the rejection names the cause and `<stateDir>/logs/engine-install-drift.json` (0600, latest
failure) explains it: which manifest or package failed first, what version was expected and found (or the read
error), and which npm produced it.

## Driving it with node scratch consumers

From a built worktree root, create an exclusive scratch dir (SKILL.md Drive), write a fake `npm` executable
(`npmPath` kit option) that seeds every locked package from the shipped `engine/package-lock.json` with the correct
version except one fixture package forced to `0.0.0-forced-drift`, prints a warning to stderr, and answers
`--version`; then drive `new OpenClawKit({ stateDir, engineDir, npmPath, transport: fakeGateway().factory })`
(imported from `@byokit/openclaw` / `@byokit/openclaw/testing`) through a failing `kit.prepare()`. The consumer
catches and prints the real rejection, then reads and prints `<stateDir>/logs/engine-install-drift.json` and checks
every field above plus the cap and the deleted temp. Offline; no registry access.

## Gotchas

- `EnginePatchError` is not a public export; the consumer observes the rejection message
  (`engine-patch: drift-after-build …`), `kit.state` (`why: 'engine-patch'`, `patchSet: null`) and the diagnostics
  file.
- The record is overwritten per failure: it diagnoses the latest install failure only.
- Frozen published sets are 0555/0444 on purpose; chmod scratch trees before removing them.
