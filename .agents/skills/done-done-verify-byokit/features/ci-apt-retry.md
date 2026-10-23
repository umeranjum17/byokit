# CI apt steps retry and fail fast

A hung package mirror used to stall a CI job's `apt-get update && install` until the job's own timeout cancelled it and `ci-ok` failed. The two apt steps (`record-recorder`, `secrets-keyring`) now retry with bounded timeouts, so a hang fails in minutes and a flake passes on a later attempt.

## Sub-features

- `retry-passes`: when the first apt calls hang or fail, the step tries again (up to three attempts) and exits 0 as soon as `update` and `install` both succeed.
- `gives-up`: when every attempt fails the step exits non-zero after exactly three attempts, so a dead mirror is a red job, not a 20 minute hang.
- `bounded`: apt gets `Acquire::Retries=3` and 30 second http/https timeouts, each call is capped at 150 seconds, and the step has `timeout-minutes: 8`, inside the job's own limit.

## How to get to it (user POV)

- A maintainer pushes a change that runs the `record-recorder` or `secrets-keyring` job while the Ubuntu mirror is slow: the job retries the install and goes green, or fails within about eight minutes of the step starting.

## Driving it with a fake apt

Preconditions: worktree root, a committed tree. No build, no model, no network.

- **The journey.** `done-done verify --feature ci-apt-retry --outcome "<claim>"` runs `capture/ci-apt-retry.sh`: it takes each apt step's own script out of `.github/workflows/ci.yml`, puts a fake `sudo` first on PATH that fails a set number of apt calls, and runs the script with 0, 2 and 100 failing calls. It writes `ci-apt-retry.log` with the step and job timeouts and each run's exit code and apt call count.
- **Expected.** 0 failing calls: exit 0 after 2 calls. 2 failing calls: exit 0 after 4 calls (third attempt). 100 failing calls: exit 1 after 3 calls. Final line `RESULT: PASS`.

## Gotchas

- The real mirror hang itself cannot be driven offline; the forge's CI run of the job is the live proof.
- The capture runs the workflow's script text, so a change to the loop in `ci.yml` is exercised, not a copy of it.
