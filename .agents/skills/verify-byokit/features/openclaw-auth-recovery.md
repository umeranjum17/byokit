# OpenClaw sealed sign-in recovery

Verification recipe for [OpenClaw's sealed sign-in recovery](../../../../packages/openclaw/README.md#credential-sealing-and-threat-model).

## Sub-features

- Healthy restart restores task-private credential state and seals it again on stop.
- Wrong-seal startup rejects with `AuthStoreUnreadableError`, `code: 'auth-store-unreadable'`, recovery words and `failed` state; no gateway connects.
- Failed-start cleanup and stop retain the original sealed snapshot byte for byte at its original path.
- Correct-seal retry restores the original task-private sign-in.

## How to get to it (user POV)

Follow the [host recovery procedure](../../../../packages/openclaw/README.md#credential-sealing-and-threat-model); the consumer below drives it with synthetic credentials.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-auth-recovery.mjs` from the worktree root:

```bash
feature=openclaw-auth-recovery
entry=.agents/skills/verify-byokit/capture/openclaw-auth-recovery.mjs
drive=(node "$entry" "$evidence_dir")
```

Use SKILL.md's Evidence capture block after allocating `evidence_dir`, or the task's explicitly authorized evidence directory. Record the command and exit code. The consumer imports the built public OpenClaw and Secrets entries, uses real `hostKeySeal` encryption, and the kit's loopback-free `fakeGateway` transport only for the normal handshake. No provider or device sign-in. The credential is a synthetic Umer marker, never an owner credential. `--baseline` is only for the pre-fix reproduction; omit it for acceptance.

## Gotchas

The private state uses a short `.verify-artifacts/auth-*` path to stay below Unix socket path limits, and is removed in `finally`; retained logs go to the supplied evidence directory. This verifies the real SDK/store and seal boundary, not provider OAuth validity or a spawned engine. There is no changed app screen, theme or device UI; recovery words are checked as public SDK output.
