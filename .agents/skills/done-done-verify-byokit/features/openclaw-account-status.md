# OpenClaw: one account that cannot be checked reads unknown, never signed out

A consumer app lists a member's accounts (Claude Code and ChatGPT, side by side) and decides when to ask the person to sign in. `kit.accountStatus(member, id, { fresh })` answers `{ state: 'ready' | 'signed_out' | 'unknown', checkedAt, reason?, retryAfterMs? }` per account, and `kit.accounts(member)` rows carry `state: 'unknown'` for a sign-in that could not be checked. A timeout, a failed request or an answer that says nothing is unknown (`reason` `timeout`, `unavailable` or `unreadable`), never signed out, and is not kept; only Claude Code reporting "not logged in" is signed out, and only for that account.

## Sub-features

- `slow-probe-one-account`: A's probe times out: A reads `unknown` with `reason: 'timeout'` and a `retryAfterMs`, B still reads `ready`, and neither row is `signed_out`.
- `unknown-not-sticky`: an answer with no `credentials` reads `unknown` (`unreadable`); the next real answer reads at once, with no wait for a cache.
- `revocation-one-account`: Claude Code reports not logged in: A reads `signed_out`, B stays `ready`.
- `run-on-unchecked-account`: a run on an account whose check fails ends `kind: 'network'` with "I couldn't check <name> yet" and `retryAfterMs`, makes no `agent` request and tries no other account.

## How to get to it (user POV)

- The app constructs `new OpenClawKit({ stateDir, engineDir })`, `start()`s it, then calls `accounts(member)` and `accountStatus(member, id, { fresh: true })`, and asks for a sign-in only on `'signed_out'` or `'needs_again'`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Offline journey.** `sh scripts/test.sh packages/openclaw/test/readiness.test.ts packages/accounts/test/cli.test.ts` runs the readiness journey on the fake gateway and the CLI status rows: expect them to pass.
- **Public-entry drive.** `feature=openclaw-account-status; entry=.agents/skills/done-done-verify-byokit/capture/openclaw-account-status.mjs; drive=(node "$entry" "$evidence_dir")` after `npm run build`, then SKILL.md's Evidence capture block. The script imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries and runs in well under a second.

## Gotchas

- `signedIn` still returns `false` for unknown; `signInState` and `accountStatus` tell the two apart.
- A limit rest is still signed in: `accountStatus` reads `ready` while `accounts()` says `resting`.
- The kit binds a Unix socket under its state dir, so the script keeps that dir at a short path (`/tmp/bas-*`, removed at the end).
