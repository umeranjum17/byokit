# OpenClaw re-detect installed Claude login

When the installed Claude login changes after the kit starts, the next setup detection notices it, restarts its engine process onto the installed login, and reports Claude signed in without an app restart.

## Sub-features

- Signed-out installed Claude selects the engine-owned fallback and is reported as needing sign-in.
- A later confirmed installed login is detected on the next call; the kit restarts its engine process (the Gateway's own restart is in-process under `OPENCLAW_NO_RESPAWN` and would keep `CLAUDE_CONFIG_DIR`), the new process has no `CLAUDE_CONFIG_DIR`, and the same call reports signed in.
- An unknown probe preserves the current login selection (covered by the adjacent engine isolation contract).

## How to get to it (user POV)

Start the OpenClaw kit while installed Claude is signed out. Sign in to Claude Code in the same HOME, then invoke setup detection again. The app stays running.

## Driving it with node scratch consumers

The integration journey uses `OpenClawKit.call('openclaw.setup.detect')` against the pinned real Gateway and a fake installed `claude` executable; its HOME and status file are isolated. Run:

```sh
sh scripts/test.sh packages/openclaw/test/engine/signin.test.ts --test-name-pattern='setup.detect rechecks a newly signed-in installed Claude'
```

It asserts the first detection is signed out, changes only the fake CLI status file, then asserts the next detection is signed in, the same kit remains ready, the Gateway pid changed, and its child environment has no `CLAUDE_CONFIG_DIR`.

## Gotchas

- The fake CLI must answer `auth status --text` as well as `--json`: the Gateway's detection reads `--text` (exit 0 = logged in), the kit's probe reads `--json`.
- Never use or copy `~/.claude`; the fake CLI reads only its task-owned status file.
- The second call itself must trigger restart; do not stop/start the kit in the test.
- A test-wrapper `~/.pi` session-file change is not a product failure; the wrapper confirms installed Pi files remain byte-for-byte unchanged.
