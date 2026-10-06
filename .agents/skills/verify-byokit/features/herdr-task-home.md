# Herdr agent pane under a task-owned HOME

A consumer app starts a Herdr agent pane with `startAgent({ env: { HOME: <task dir> } })` and the agent runs under that home: `HOME` and the XDG config, data, state and cache directories point inside the task directory, so anything the agent writes (or a sign-in inside the pane) stays there. `env: { env, unset }` replaces the whole environment instead.

## Sub-features

- `record-home`: a record env with `HOME` gives the agent process that HOME and XDG dirs under it.
- `launch-home`: a LaunchEnvironment (`{ env, unset }`) leaves the agent only the given variables.
- `inside-view`: a shell inside a pane opened with the HOME env sees the task's marker file and none of the person's agent folders.
- `existing-pane-refused`: a record env on an existing pane is refused with the typed `env_mismatch` error.

## How to get to it (user POV)

- The consumer adopts a running Herdr: `new HerdrKit({ mode: 'adopt', bin, socketPath })`, `await kit.start()`, then `kit.startAgent({ kind: 'pi', name, cwd, place: { workspace: 'new' }, env })` (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); `/usr/bin/herdr` at the pinned version (`herdr --version` prints `herdr 0.9.1`); the `pi` CLI installed (its directory goes on the pane PATH; no sign-in is used); and an **isolated, non-default Herdr session** provisioned and torn down by the environment's Herdr lab helper, whose socket path the drive receives as its first argument. Never adopt the person's own Herdr session.

- **Write the consumer.** `"$scratch_dir/verify-herdr-task-home.mjs"` importing `HerdrKit` from `@byokit/herdr`, taking `socketPath`, a fresh task directory and the pi directory as arguments. For `record-home` and `launch-home` it writes `byk-marker` into a per-case home, calls `startAgent` with a distinct `name` per case, finds the agent pid via `kit.call('pane.process_info', …)` (the foreground process that is not the shell) and prints `HOME`, the four `XDG_*` values and the key count from `/proc/<pid>/environ`, plus the task home's entries. For `inside-view` it opens a pane with `kit.call('workspace.create', { cwd, focus: false, env: { HOME } })`, sends `cat "$HOME/byk-marker"` and `test -e` checks for `.pi .claude .codex .config/opencode` with `pane.send_text`, and prints `kit.read(pane, { source: 'recent_unwrapped' })`. For `existing-pane-refused` it calls `startAgent({ place: { pane: <that pane> }, env: { HOME } })` and prints the caught error's `code` and `message`. It asserts each expectation and exits non-zero on any mismatch, then `await kit.stop()` (adopt mode never stops the server).
- **Run and capture.** `feature=herdr-task-home; entry=@byokit/herdr; drive=(<lab wrapper> node "$scratch_dir/verify-herdr-task-home.mjs")`, where the wrapper provisions the lab session, passes its socket and a fresh task directory, and tears down on EXIT; then run SKILL.md Evidence's capture block. Exit code `0`.
- **record-home shows.** `HOME` is the task home and every `XDG_*_HOME` starts with it; the task home now holds `.pi` beside `byk-marker`.
- **launch-home shows.** `HOME` is the task home, the four `XDG_*` are unset and only the passed keys remain.
- **inside-view shows.** The pane prints `HOME=<task home>`, `task-home-marker` and `absent` for every personal folder.
- **existing-pane-refused shows.** `env_mismatch` with "This pane needs to be opened again to use that sign-in."

## Gotchas

- Two `startAgent` calls of one kind without `name` collide on the server (`agent_name_taken`); give each a name.
- The lab session's socket path must stay under 108 bytes: a long session label or state directory makes `herdr server` exit silently and provisioning time out.
- Panes inherit the server's other variables under a record env; only `{ env, unset }` replaces them.
- Cleanup: the lab wrapper's teardown stops the session; then SKILL.md Cleanup removes only "$scratch_dir" and confirms the evidence survives.
