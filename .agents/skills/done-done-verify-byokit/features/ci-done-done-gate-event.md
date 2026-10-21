# CI done-done gate on a pull request only

CI's `done-done` job judges the committed receipt against the commit it checked out, so it is a pull-request check: on a pull request that commit is the merge commit, whose second parent is the receipt's head, so the head is an ancestor and the gate passes. A merge squashes that head away, so on a push to main the head is no ancestor of the squashed commit: the job is skipped there instead of failing every merge, and the `ci-ok` aggregate passes a job skipped by design.

## Sub-features

- `pr-only`: the `done-done` job's condition is `needs.changes.outputs.code == 'true' && github.event_name == 'pull_request'`, so a push to main skips the job and a pull request keeps the gate.
- `skipped-passes`: the `ci-ok` aggregate accepts `success` and `skipped` and refuses everything else, so the one required check stays green on a skipped job and still red on a job that ran and failed.
- `push-to-main-green`: a push to main is green, so the Release workflow's `workflow_run` (a successful CI run whose event is `push`) publishes the versions npm does not have yet instead of being skipped.

## How to get to it (user POV)

- A maintainer opens a pull request: its `done-done` check runs the model-free `done-done gate` against the receipt committed under `.done-done-receipts/` and is green when that receipt covers the pull request's head.
- The maintainer merges: the push to main run does not run the gate, the `ci-ok` aggregate passes the skipped job, the run is green, and the Release workflow publishes.

## Driving it with node scratch consumers

Preconditions: worktree root of the branch under test, a committed tree and the forge's own runs. This drives the CI workflow itself, not the built SDK, so no build, no model and no key are needed.

- **The journey.** `done-done verify ci-gate-event --outcome "<claim>" --claim-id <id>` (the `ci-gate-event` journey in `.done-done.yaml`) writes one capture, `ci-gate-event.log`, holding: the `done-done` job's condition as it stands in `.github/workflows/ci.yml`; the gate's own ancestor rule, quoted from the failing push to main run's job log (run `39548414209`, job `done-done`); the `ci-ok` aggregate's job and its acceptance set; what GitHub Actions really did on the real runs `39548414209` (push to main: `done-done` failure, `ci-ok` failure) and `39549914720` (pull request: 15 jobs skipped by their own area, `ci-ok` success); and the Release workflow's `publish` condition.
- **By hand.** From the worktree root: `awk '/^  done-done:$/{p=1} p&&/^  [a-z0-9-]+:$/&&!/^  done-done:$/{exit} p' .github/workflows/ci.yml` prints the job; `gh-axi run view 39548414209 --job 119051848588 --log` prints the failing gate's own message; `gh-axi run view 39549914720` prints the real skipped jobs and the green aggregate. Capture each with SKILL.md's Evidence capture block.
- **Expected.** The job's condition names `github.event_name == 'pull_request'`; the aggregate's script accepts `skipped`; the push to main run shows the gate's ancestor failure and the pull request run shows the aggregate green over skipped jobs.

## Gotchas

- The gate needs the history back to the receipt head (`fetch-depth: 0`); without it every receipt head reads as "not an ancestor of it".
- A receipt names the head of the pull request that produced it, never the merge commit; after a squash that head is on no branch, which is why the gate cannot run on main.
- `ci-ok` must keep `done-done` in its `needs:` list, or the required check stops covering the gate.
- The gate passes when one committed receipt covers the head; older receipts under `.done-done-receipts/` that no longer cover it do not fail it.
- The job installs `done-done-axi` from npm and runs the model-free `done-done gate`; it reads git objects only, so CI starts no journey, judge, model or key.
