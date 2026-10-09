# OpenClaw sealed sign-in recovery

Verification recipe for [OpenClaw's sealed sign-in recovery](../../../../packages/openclaw/README.md#credential-sealing-and-threat-model).

## Sub-features

- Healthy restart restores task-private credential state and seals it again on stop (supplied fakeGateway leg, file-marker level).
- Wrong-seal startup rejects with `AuthStoreUnreadableError`, `code: 'auth-store-unreadable'`, recovery words and `failed` state; no gateway connects (supplied leg, and spawned-engine-kit legs whose engine set stays untouched before recovery and whose installed engine never starts after it).
- Failed-start cleanup and stop retain the original sealed snapshot byte for byte at its original path (every leg).
- Correct-seal retry restores the original task-private sign-in (supplied fakeGateway leg).
- After recovery, an original-key retry and a later healthy restart reach `ready` through a real spawned pinned engine: `hello.server.version` equals the pin, the restored synthetic sign-in is admitted by a real native auth probe through the offline CLI stand-in, and stop re-seals it. Provider authenticity is out of scope.

## How to get to it (user POV)

Follow the [host recovery procedure](../../../../packages/openclaw/README.md#credential-sealing-and-threat-model); the consumer below drives it with synthetic credentials.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-auth-recovery.mjs` from the worktree root. It needs an absolute task-private scratch root (pinned-engine install and runtime state; keep it outside the worktree, never `/tmp`):

```bash
feature=openclaw-auth-recovery
entry=.agents/skills/verify-byokit/capture/openclaw-auth-recovery.mjs
drive=(node "$entry" "$evidence_dir" "$HOME/.cache/fm-scratch/<task>/openclaw-auth-recovery")
```

Use SKILL.md's Evidence capture block after allocating `evidence_dir`, or the task's explicitly authorized evidence directory. Record the command and exit code. The consumer imports the built public OpenClaw and Secrets entries, uses real `hostKeySeal` encryption, and drives two clearly labeled gateways: the kit's loopback-free `fakeGateway` transport only for the marker-level legs, then the real spawned pinned engine with an offline native Claude CLI stand-in for readiness. No provider or device sign-in, no spend; the first spawned-engine run installs the pinned engine (npm registry egress only). The credential is a synthetic Umer marker, never an owner credential. `--baseline` is only for the pre-fix reproduction of the marker legs; omit it for acceptance.

## Gotchas

The private state and engine sets live under the supplied absolute scratch root, chosen to keep Unix socket paths (`<root>/openclaw/bridge.sock`) below the host limit; the state dir is removed in `finally`, the engine set survives for reuse, and retained transcripts go to the supplied evidence directory. Every transcript line names its gateway (`spawned pinned engine` or `supplied fakeGateway`): only the spawned-engine legs claim readiness, and neither claims real provider OAuth validity — the native stand-in is offline. There is no changed app screen, theme or device UI; recovery words are checked as public SDK output. Run the spawned-engine phase under the host's heavy-job lock and memory gate (the install is bulky).
