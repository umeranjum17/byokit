# OpenClaw sign-in again right after a cancel

After a person cancels an OpenClaw sign-in and its `done` settles, the next sign-in is admitted with no retry or pause: when the engine answers the cancel `cancelled`, the [sign-in contract](../../../../docs/runtime-kits.md#57-sign-in-routes-and-retained-login-migration) waits, up to 10 s, for the engine to free its single setup admission before `done` settles. Gotchas lists what it does not cover.

## Sub-features

- Cancel then start: `signIn(...).cancel()`, `await done` (`why: 'declined'`), then an immediate new `signIn` shows its own authorize URL instead of ending `why: 'busy'`.
- A sign-in started while another one still waits ends `why: 'busy'`, the engine's one setup admission held.
- The second sign-in cancels cleanly as well.

## How to get to it (user POV)

An app offers OpenRouter (`KitOptions.offered`), the person starts its code sign-in, cancels from the paste prompt, and taps the same card again. Before the fix the second tap failed with "Another sign-in is already in progress" (Crewhouse's words for `why: 'busy'`), because the engine answered the cancel before it had released its setup lock.

## Driving it with node scratch consumers

Build and doctor per SKILL.md. The maintained consumer imports only the public built `@byokit/openclaw` and runs the pinned engine. Nothing leaves the host: OpenRouter's code route builds its authorize URL locally and the drive cancels at the paste prompt. On Linux:

```bash
feature=openclaw-cancel-admission
entry=capture/openclaw-cancel-admission.mjs
# Absolute, exclusive worktree path (Unix socket length); avoid RAM-backed /tmp.
scratch_dir=$(mktemp -d "$PWD/scratch.verify-byokit.XXXXXX") || exit 1
export CANCEL_SCRATCH="$scratch_dir"
drive=(node .agents/skills/verify-byokit/capture/openclaw-cancel-admission.mjs)
```

Run the SKILL.md Evidence block under the host's heavy-job lock and memory gate. Set `BYOKIT_TEST_ENGINE_DIR` to an already installed pinned engine set to reuse it; otherwise the first run installs one into `$scratch_dir/engine`. Output has one JSON line per view with ms timestamps. It includes the rival's `busy` end, the first sign-in's `cancelToDoneMs`, and the next sign-in's `doneToViewMs` with its authorize URL (origin and path only). Exit 0 and `CANCEL-ADMISSION OK` require every control. Keep the transcript, then remove only `$scratch_dir`.

Existing engine integration coverage: `BYOKIT_TEST_ENGINE_DIR=<installed set> sh scripts/test.sh --test-name-pattern=cancelled packages/openclaw/test/engine/signin.test.ts`. It runs ChatGPT device code against `mockOpenAI()`, cancels at 0 ms and after the code is shown, and prints each session's start, cancel and `wizard.status` answers.

## Gotchas

- Run engine jobs with `PATH="/usr/bin:$PATH"` where `npm` is a mise shim: under a throwaway HOME the shim refuses and the install fails as `engine-patch: write`.
- `done` waits at most 10 s for the engine's settlement after a `cancelled` answer. Not waited on: a cancel the engine refuses because the sign-in is committing (answered `running`), and a session the engine purged at the cancel because its runner had already finished.
- A full OpenRouter or ChatGPT sign-in is not proven here: completing one needs a real provider account and network.
- No UI changed; no screenshots.
