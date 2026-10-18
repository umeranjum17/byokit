# Native delegated tool admission

Build and doctor using the parent skill. The maintained journey imports only the **built public** kit/testing entries;
it uses a real pinned Gateway and the HTTP scripted provider, never a fake kit or Gateway. No credentials, sign-in or
model spend are needed. Prepare the pinned engine once under a task-owned, disk-backed `engine_dir` with
`new OpenClawKit({ stateDir: bootstrap_dir, engineDir: engine_dir }).prepare()`; do not use a personal engine home.

```bash
feature=openclaw-native-delegation
entry=packages/openclaw/test/engine/delegation.test.ts
drive=(env BYOKIT_TEST_ENGINE_DIR="$engine_dir" sh scripts/test.sh "$entry")
```

Capture this command with the parent Evidence block or the task's authorized external evidence directory.
The runner isolates HOME/TMPDIR, blocks non-loopback runtime traffic, and checks the real Pi files byte-for-byte.
The proof asserts native `sessions_send` to a standing helper and `sessions_spawn` to an isolated child, exact
actor/member/parent/run identity, parent settlement while a child remains admitted, denial then approval of separate
child actions, the intersection of parent/target app tools, unknown-child refusal before the host gate, retained exact
receipts readable by a fresh kit, active-call cancellation, and no revival of revoked children after engine restart.
Native tool and terminal events must reach `byokit.delegated`. Remove only the task-owned engine install after proof.

This is backend behavior: no screenshots. It does **not** qualify shared helper credentials, OAuth refresh ownership,
ACP delegation, synchronous/label-based sends, or resumption under a new engine run ID. A receipt absent after a crash
is fail-closed, not reconstructed. The target keeps its own existing accounts. Do not relabel the scripted provider
as an authenticated subscription or the fresh-kit journal read as an actual live reconnect.
