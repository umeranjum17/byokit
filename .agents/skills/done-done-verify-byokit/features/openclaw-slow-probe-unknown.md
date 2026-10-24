# OpenClaw: a slow sign-in check reads unknown, never signed out

A consumer app asks `@byokit/openclaw` whether a member is signed in to Claude Code. The engine answers by running `claude auth status` with a hard 3 s limit; a slow machine used to make that read as "not signed in", and apps signed the person out. The kit now retries a failed or timed-out probe fresh until 12 s have passed (past the engine's 10 s window) and then reads *unknown*: `kit.signInState(member, provider)` is `'unknown'`, `providerStatus` is `undefined`, and a run's admission check ends `network` (retry), not `signed-out`. A probe that answers signed out still reads signed out.

## Sub-features

- `slow-probe-unknown`: a probe that errors after 3.5 s every time reads `unknown` after at least 10 s of retries; the run ends `network`.
- `probe-recovers`: a probe that errors twice and then answers reads `signed-in`; the run is ok.
- `signed-out-still-reads`: a probe that answers `credentials: false` reads `signed-out`; the run ends `signed-out`.

## How to get to it (user POV)

- The app constructs `new OpenClawKit({ stateDir, engineDir })`, `start()`s it, then calls `signInState(member, 'claude-cli')` (or `run` with a `claude-cli/...` model) and decides on a sign-out only for `'signed-out'`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Offline journey.** `sh scripts/test.sh packages/openclaw/test/kit.test.ts` runs the three `a Claude Code probe that ...` tests on the fake gateway (mock timers): expect them to pass.
- **Public-entry drive.** `feature=openclaw-slow-probe-unknown; entry=.agents/skills/done-done-verify-byokit/capture/openclaw-slow-probe-unknown.mjs; drive=(node "$entry" "$evidence_dir")` after `npm run build`, then SKILL.md's Evidence capture block. The script imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries and runs the three probes in real time (the slow case takes about 14 s).

## Gotchas

- An unknown answer is never kept: the next reader probes again. `signedIn` still returns `false` for unknown; only `signInState` tells the two apart.
- The account list reads a failed probe as `unknown` for an account it already lists (see [openclaw-account-status](./openclaw-account-status.md)); an account it never listed stays absent. The person's session is not touched by it.
- The kit binds a Unix socket under its state dir, so the script keeps that dir at a short path (`/tmp/bsp-*`, removed at the end) when the run's scratch path is long; a long path fails the bind, not the proof.
