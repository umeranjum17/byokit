# Herdr agent launch hint (Node 24/26 detection)

A consumer starts any agent kind through `@byokit/herdr` and the kit sets Herdr's documented `HERDR_AGENT` hint on the agent's own process: every `agent.start` first defines a shell function in the idle pane shell, so the launch command the server types runs `env HERDR_AGENT=<kind> <executable>`. Herdr 0.9.1 names a pane's foreground agent by process name; Node 24 and 26 rename the runtime main thread (`MainThread`, `node-MainThread`), so a CLI running on those runtimes (Gemini CLI proved) goes unidentified and a plain start times out. With the kit, the hint rides the launch command — never the pane env, where it marks the shell itself and the start is refused `agent_pane_busy` — so no consumer-side `gemini` wrapper on the pane PATH is needed.

## Sub-features

- `hint-on-launch`: a `startAgent` of any kind sources a private `hint.sh` into the idle pane shell before `agent.start`, defining `<executable>() { env HERDR_AGENT=<kind> <executable> "$@"; }`, and the start resolves.
- `agent-env-hint`: the launched agent's `/proc/<pid>/environ` carries `HERDR_AGENT=<kind>` while the pane shell's environ does not.
- `ready-on-new-node`: on a Node 24 or 26 runtime — where a plain start of the same CLI times out ("timed out waiting for agent startup") — the kit's start reports the kind, `idle` and ready.
- `no-wrapper`: no `gemini` (or other kind) wrapper sits on the pane PATH; the kit's function is the only hint mechanism.
- `busy-pane-silent`: a start aimed at a pane whose foreground is not an idle POSIX shell types nothing (no sourcing line) and proceeds as before.
- `non-posix-silent`: a pane running fish/csh/pwsh is never typed into; the start proceeds exactly as before the feature.

## How to get to it (user POV)

- The consumer adopts a running Herdr: `new HerdrKit({ mode: 'adopt', bin, socketPath })`, `await kit.start()`, then `kit.startAgent({ kind: 'gemini', name, cwd, place: { workspace: 'new' } })` — no env, no wrapper (packages/herdr/README.md, Account-specific sign-ins and moves).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); `/usr/bin/herdr` at the pinned version (`herdr --version` prints `herdr 0.9.1`); the installed Gemini CLI 0.56.0 bundle's absolute `bundle/gemini.js`; `/usr/bin/node` plus Node 22, 24 and 26 builds under the task scratch (never installed globally); and an **isolated, non-default Herdr session** provisioned and torn down by the environment's Herdr lab helper, whose socket path the drive receives as its first argument (a `--herdr-lab` brief). Never adopt the person's own Herdr session.

- **Write the consumer.** `"$scratch_dir/verify-herdr-agent-hint.mjs"` importing `HerdrKit` from `@byokit/herdr`, taking the socket path, the gemini.js path, the per-version node binaries and a fresh task directory. For each node version it writes `byokit-gemini` on the pane PATH — a one-line `exec <node> <gemini.js> "$@"` shim that pins the runtime and adds no `HERDR_AGENT` — makes a workspace with `workspace.create` (cwd under the task directory, a synthetic `.gemini/settings.json` root, usage statistics and update checks off), then calls `startAgent({ kind: 'gemini', name: <unique per version>, place: { pane }, installProbe: { path: [shim dir] } })`. It prints the pane read after the start (the sourcing line and marker), `agent.get` polled until the kind leaves `unknown`, each Gemini process's argv plus `HERDR_AGENT`, `HOME` and `PATH` from `/proc/<pid>/environ`, and the shim dir listing (no `gemini` wrapper beyond the runtime-pinning shim — the kit's function, not a wrapper, must carry the hint). It asserts each expectation and exits non-zero on any mismatch, then `await kit.stop()` (adopt mode never stops the server).
- **Run and capture.** `feature=herdr-agent-hint; entry=@byokit/herdr; drive=(<lab wrapper> node "$scratch_dir/verify-herdr-agent-hint.mjs" <gemini.js> <node22> <node24> <node26>)`, where the wrapper provisions the lab session, passes its socket and a fresh task directory, and tears down on EXIT; then run SKILL.md Evidence's capture block. Exit code `0`.
- **hint-on-launch shows.** Each pane's read shows the kit's `set +x +v; . '/…/byokit-agent-…/hint.sh'` sourcing line and no other kit keystrokes; the start resolves instead of timing out.
- **agent-env-hint shows.** Every Gemini process carries `HERDR_AGENT=gemini` in its environ; the pane shell's environ carries none.
- **ready-on-new-node shows.** On all three node versions `agent.get` reports `gemini`, `idle` and ready; on 24 and 26 this is the version whose plain start (no kit hint) times out.
- **no-wrapper shows.** The shim dir holds only the runtime-pinning shim; `HERDR_AGENT` reaches the agent with no PATH wrapper setting it.
- **busy-pane-silent shows.** A start aimed at a pane with a live agent (or any non-shell foreground) adds no sourcing line to that pane and still answers.
- **non-posix-silent shows.** A pane whose shell reports `fish` (or another non-POSIX name) is never typed into; the start behaves exactly as before the feature.

## Gotchas

- Two `startAgent` calls of one kind without `name` collide on the server (`agent_name_taken`); give each a name.
- The lab session's socket path must stay under 108 bytes: a long session label or state directory makes `herdr server` exit silently and provisioning time out.
- The hint is best effort by contract: a busy pane, a non-POSIX shell, or a server without `pane.process_info` starts exactly as before — assert silence, never failure.
- The hint value is the canonical kind Herdr will parse (`claude-code` hints `claude`); the function name is Herdr's launch executable for the kind (`cursor-agent`, `kiro-cli`), not always the kind.
- `agent.start` needs the pane at a shell prompt and blocks until detection; keep the generous default timeout when driving slow runtimes.
- Cleanup: the lab wrapper's teardown stops the session; then SKILL.md Cleanup removes only "$scratch_dir" and confirms the evidence survives.
