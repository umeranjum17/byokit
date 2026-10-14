# Engine-owned remote plan sign-in

## Sub-features

- `anthropic-cli` runs Claude Code's own login with the engine's `CLAUDE_CONFIG_DIR` (in its own login HOME); only engine readiness plus live activation completes it. `openai-device-code` (`via: 'code'`) uses the engine wizard with no phone-local callback.
- Wrong code, expiry, cancel or a missing CLI never activates. The commit point is `setup.activate`: a cancel before it declines, after it the engine's answer stands. Runtime-owned CLI folders survive cancelled rows.
- A plan-key choice such as `opencode-go` is not a wizard sign-in: the view waits for the pasted plan key and commits at `setup.activate` only once one is pasted. Stopping the engine before the paste declines the drive at once (the engine's `stopSignal` reaches the drive through the kit's sign-in context), activating nothing; a paste nobody answers still ends at the 15-minute paste wait.

## Offline drive

Launch and Doctor, then import built `@byokit/openclaw` (with `/testing`, `/link`, `/device`) into an external scratch consumer. Put a task-owned fake `claude` on `enginePath` and drive phone start/view/paste/cancel through `openclawLink` for wrong code, expiry, cancel and success: no activation on failures, ready only from engine readback, and a folder canary surviving cancel. For the key-paste shutdown, build the kit with `spawnEngine: false` and `fakeGateway({ 'openclaw.setup.activate': … })`, start `oc.signin.start { provider: 'opencode-go', via: 'code' }`, wait for the `Plan key` prompt, `await kit.stop()`, then read `oc.signin.view`: `failed` with `why: 'declined'` in milliseconds, the scripted activation never called. Source regression: `packages/openclaw/test/signin.test.ts` and `packages/accounts/test/remote-cli.test.ts`.

## Authorized live phone drive

Needs explicit approval to sign in and run real turns; not in the offline baseline. Never copy credentials. Use a real pinned engine in an external state directory and a task-owned emulator paired over Pair; no physical phone. Sign in to Claude and to OpenAI (device code), send one real `oc.run` per provider, and capture the waiting and done screens with `adb -s <emulator> exec-out screencap -p` once the engine view and the phone show the same state, the code field empty. A missing authorization, emulator, sign-in or turn stays **not proven**.
