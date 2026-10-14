# Release publish on a superseded workflow_run sha

A release publish that runs from `workflow_run` checks out the exact sha its CI passed, so a later merge on main leaves that run's publish step on a sha that is no longer `origin/main`; it now exits 0 with a `superseded by <sha>` note, because the later merge's own run covers that publish, and every other HEAD mismatch still fails.

## Sub-features

- `superseded-exit`: `workflow_run` with HEAD an ancestor of `origin/main` but not equal to it prints `superseded by <origin/main sha>` and exits 0, without publishing, without the CI gate, and with nothing written.
- `other-mismatches-fail`: a manual `workflow_dispatch` on the same stale sha, or a `workflow_run` whose HEAD is not on main at all, still fails with `publish refuses: HEAD != origin/main` and exits 1.
- `dry-run-unchanged`: a dry run on a stale head keeps its old warning path and never takes the superseded exit.
- `on-main-unchanged`: a HEAD equal to `origin/main` never reaches the check and publishes as before.

## How to get to it (user POV)

- Two merges land on main minutes apart; each gets its own CI run and its own release `workflow_run`. The earlier run's publish step checks out its own sha, finds `origin/main` already past it, logs `superseded by <sha>` and exits 0, leaving the run green while the later merge's run publishes.

## Driving it with node scratch consumers

Preconditions: worktree root of the branch under test. This drives the release tooling itself, not the built SDK, so no build and no network are needed: the fixture origin is a local bare repository.

- **Build the fixture outside the worktree** (the run's own scratch parent): a parent directory holding `repo/` and `origin.git`; copy the checkout's `scripts/release.ts` into `repo/scripts/`; in `repo/` run `git init -q -b main`, `git remote add origin <parent>/origin.git`, `git add .`, commit, `git push -q origin main`, an empty commit for the later merge, push again, then `git checkout -q HEAD~1` so HEAD is detached at the superseded sha.
- **Superseded leg.** From `repo/` run `env GITHUB_EVENT_NAME=workflow_run node scripts/release.ts publish`; assert exit code 0 and stdout matching `superseded by <sha>`, where `<sha>` is `git rev-parse origin/main` after the step's own `git fetch origin main`.
- **Failing legs.** The same fixture run with `GITHUB_EVENT_NAME=workflow_dispatch` and with the variable unset: exit code 1 and stderr matching `/publish refuses: HEAD != origin\/main/`. Then `git checkout -q -b off-main`, an empty commit (a head never on main), and the same run under `workflow_run`: the same failure.
- **Expected.** The superseded leg writes no notes, publishes nothing and touches no package; the failing legs stop before the CI gate. Capture each leg's command, stdout, stderr and exit code in the evidence folder with SKILL.md Evidence's capture block, one leg per run directory.

## Gotchas

- The bare remote must live outside `repo/`, or `git status --porcelain` sees it as untracked and publish refuses a dirty tree.
- The check reads `GITHUB_EVENT_NAME` from the environment, which release.yml provides; a local run without it behaves like a manual dispatch.
- A HEAD equal to `origin/main` is the on-main path and never reaches the check; only strictly older ancestor shas exit clean, and an unknown ref fails closed as a mismatch.
- `npm test` covers this as the publish CLI tests in `scripts/release.test.ts`; this feature is the host proof that the real script takes the two paths.
