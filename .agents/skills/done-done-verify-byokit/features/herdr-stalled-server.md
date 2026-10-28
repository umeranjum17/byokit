# Herdr stalled server recovery

The built `@byokit/herdr` is proved by two complementary journeys:

- Real server: run `packages/herdr/test/lab/liveness.lab.ts` against a provisioned non-default Herdr lab session. Pass `HERDR_LAB_SOCKET` and the PID of that lab's `herdr server` process; it reaches ready, sends SIGSTOP, asserts `stalled` and `snapshot().connected === false` within 20 s, sends SIGCONT, then asserts `ready` and connected within 10 s. The lab helper provisions and tears down the session and verifies its default-session tripwire. Never target the default session or a process not started by this lab.

Capture command and output under `.verify-artifacts/herdr-stalled-server/` for fake coverage. The required real-server proof is kept in the task's external evidence folder; it is not run as part of `npm test` because it needs the guarded Herdr lab helper.
