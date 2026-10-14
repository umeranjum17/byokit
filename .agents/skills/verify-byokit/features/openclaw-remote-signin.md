# Engine-owned remote plan sign-in

## Sub-features

- `anthropic-cli` runs Claude Code's own login in the engine HOME and `CLAUDE_CONFIG_DIR`; only engine readiness plus live activation completes it. `openai-device-code` (`via: 'code'`) uses the engine wizard with no phone-local callback.
- Wrong code, expiry, cancel or a missing CLI never activates. The commit point is `setup.activate`: a cancel before it declines, after it the engine's answer stands. Runtime-owned CLI folders survive cancelled rows.

## Offline drive

Launch and Doctor, then import built `@byokit/openclaw` (with `/testing`, `/link`, `/device`) into an external scratch consumer. Put a task-owned fake `claude` on `enginePath` and drive phone start/view/paste/cancel through `openclawLink` for wrong code, expiry, cancel and success: no activation on failures, ready only from engine readback, and a folder canary surviving cancel. Source regression: `packages/openclaw/test/signin.test.ts` and `packages/accounts/test/remote-cli.test.ts`.

## Authorized live phone drive

Needs explicit approval to sign in and run real turns; not in the offline baseline. Never copy credentials. Use a real pinned engine in an external state directory and a task-owned emulator paired over Pair; no physical phone. Sign in to Claude and to OpenAI (device code), send one real `oc.run` per provider, and capture waiting and done screens with `capture/openclaw-remote-signin.mjs`. A missing authorization, emulator, sign-in or turn stays **not proven**.
