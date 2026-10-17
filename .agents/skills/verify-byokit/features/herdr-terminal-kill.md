# Herdr terminal close: TERM then KILL

`kit.terminal(...).close()` sends SIGTERM first, then SIGKILL after a grace period
(`killGraceMs`, default 3000) when the child ignores SIGTERM, and `exited` settles in both
cases (issue 404: a `herdr terminal session` child that traps SIGTERM never exited and leaked
muxr host memory). A well-behaved child that exits on SIGTERM never waits for the grace.

## Sub-features

- `term-kill`: a child that traps SIGTERM and keeps running ends within grace + 1 s of
  `close()`, the SIGTERM marker proves TERM was delivered first, and the pid is gone
  (`process.kill(pid, 0)` throws ESRCH).
- `term-coop`: a child with no SIGTERM handler exits on SIGTERM alone well inside the grace,
  `exited` settles, and the pid is gone.

## How to get to it (user POV)

No kit start or Herdr needed: `new HerdrKit({ mode: 'adopt', bin: <fake>, socketPath: <unused> })`
and `kit.terminal('p1', { mode: 'observe', cols: 80, rows: 24, killGraceMs })`. The fake is a
pinned-shebang Node script that registers the SIGTERM trap first, then writes its pid and one
`terminal.ready` frame (the trap must precede the frame, or a fast close() TERMs an unregistered
child), and either keeps running (marker file) or dies on TERM.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, CLI, account or egress.

- **Write the consumer.** `"$scratch_dir/verify-herdr-terminal-kill.mjs"` importing `HerdrKit`
  from `@byokit/herdr`. It writes both fake binaries into the scratch dir, then:
  - `term-kill`: open with `killGraceMs: 300`, `await terminal.ready`, read the pid, `close()`,
    time `await terminal.exited` (< 400 + 1000 ms), assert the SIGTERM marker file exists and
    `process.kill(pid, 0)` throws ESRCH; `exited.code` is `null` (ended by signal).
  - `term-coop`: open with the default grace, `close()`, time `await terminal.exited`
    (< 1000 ms), pid gone by the same check.
  It exits non-zero on any mismatch.
- **Run and capture.** `feature=herdr-terminal-kill; entry=@byokit/herdr;
  drive=(node "$scratch_dir/verify-herdr-terminal-kill.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **term-kill shows.** Elapsed within grace + 1 s, the SIGTERM marker present, the pid gone.
- **term-coop shows.** Elapsed under 1 s with the default grace, the pid gone.

## Gotchas

- The scratch consumer must pass `socketPath` (adopt mode requires it) but never connects —
  `terminal()` only needs `bin` and the supervisor env.
- The fake must use `import`, not `require`: the scratch dir inherits the worktree package.json's
  `"type": "module"`. The repo's own test (tmpdir scratch) is the CJS mirror with `require`.
- The trap fake keeps itself alive with `setInterval`; after the proof nothing is left running
  because `close()` SIGKILLs it and the pid check proves it.
