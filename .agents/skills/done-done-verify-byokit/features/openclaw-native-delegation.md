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
On hosts forbidding `/tmp`, use a task-owned disk-backed `scratch` directory instead (create its `home` and XDG
subdirectories first), with the same journey and egress guard:

```bash
drive=(env HOME="$scratch/home" XDG_CACHE_HOME="$scratch/xdg-cache" XDG_CONFIG_HOME="$scratch/xdg-config"
  XDG_DATA_HOME="$scratch/xdg-data" TMPDIR="$scratch" BYOKIT_TEST_ENGINE_DIR="$engine_dir"
  NODE_OPTIONS="--require $PWD/scripts/test-egress-guard.cjs" node --test "$entry")
```

This alternative does not repeat the runner's real-Pi hash witness; retain that witness from the source/isolation
suite separately. The journey's short fixture name keeps the Unix socket inside the platform path limit.
The proof asserts native `sessions_send` to a standing helper and `sessions_spawn` to an isolated child, exact
actor/member/parent/run identity, parent settlement while a child remains admitted, denial then approval of separate
child actions, the intersection of parent/target app tools, unknown-child refusal before the host gate, retained exact
receipts readable by a fresh kit, active-call cancellation, and no revival of revoked children after engine restart.
Native tool and terminal events must reach `byokit.delegated`. Its return-run journey (5.8.4) asserts that the engine's
own reply step after a finished send child is admitted as the sender: a host call on the sender's key with the root's
member and agent, `parent` the finished child, `root` the sender, the root's system text in that run's model request,
and a plain run plus forged inter-session headers naming both another source and the exact completed child's source
on the same key still refused before the host. Admission uses native hook `inputProvenance`, never prompt text. Run it alone
with `--test-name-pattern='return run'` before `"$entry"`. Remove only the task-owned engine install after proof.

Live return-run leg (only on a lane dispatched with an approved hosted-model route): a Crewhouse checkout whose
`node_modules/@byokit/openclaw` is the built kit under test (a scratch overlay of the Crewhouse `src`, `templates`,
`package.json` and `tsconfig.json`, symlinking its other `node_modules`) runs Crewhouse's native-read pilot (Chief sends
Scout to read `facts.txt` with `crew_read`; Chief's return reads it again) on the dedicated key file, passed by path,
through the memory gate. Pass: exit 0, `childCalls: 1`, `returnCalls: 1`, the return's gated `RunRef` naming the root,
and its reply starting with the root persona's marker. The 9.33 pin waits at most 60 s for the child's terminal result:
that run fails on the deadline with no return run, an engine limit, not the kit's.

9.33 qualification gap: the full native send/spawn journey still fails its unknown-run `agent.wait` assertion:
stock returns a plain timeout without `timeoutPhase`/`providerStarted`. The kit retains the receipt conservatively;
no safe lost-vs-live equivalent was found. A passing return-run leg is not a passing full delegation qualification.
Do not skip that assertion or treat every timeout as lost.

This is backend behavior: no screenshots. It does **not** qualify shared helper credentials, OAuth refresh ownership,
ACP delegation, synchronous/label-based sends, resumption under a new engine run ID, or return runs across a kit restart. A receipt absent after a crash
is fail-closed, not reconstructed. The target keeps its own existing accounts. Do not relabel the scripted provider
as an authenticated subscription or the fresh-kit journal read as an actual live reconnect.
