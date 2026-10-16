# Service kit: per-user LaunchAgent (macOS)

`@byokit/service` on darwin writes `~/Library/LaunchAgents/com.byokit.<name>.plist`, loads it with
`launchctl bootstrap gui/<uid>` and `launchctl kickstart`, reads it with `launchctl print` and removes it with `launchctl bootout`
([spec](../../../../docs/service-kit.md) 4.2). The real install only ever runs on a **disposable GitHub-hosted
macOS runner**: never install an agent on this host or the person's Mac. The refusals (`bad-name`, `bad-bin`,
`missing-bin`) are platform-neutral; drive them as in [service-linux](./service-linux.md).

## Real host (disposable runner only)

CI job `service-macos` (`.github/workflows/ci.yml`, `macos-latest`) runs
`node --test packages/service/test/macos.journey.ts`. The journey installs a node loopback echo as `bin` and
asserts `status` `not-installed` → `running`, the plist under the login home, the echo answering on 127.0.0.1,
`launchctl print gui/$(id -u)/com.byokit.journey-echo` exit 0 with `state = running` (its state, path, program
and pid lines are printed into the job log), a re-install still answering, then after `uninstall` the plist gone,
`launchctl print` failing and `status` `not-installed`. The same file runs the `./testing` contract suite against the real launchd
(`launchd 1`–`3` run, the fake-only cases skip). It skips anywhere but GitHub Actions on macOS.

Proof = the PR's `service-macos` job log with the test line `✔`, not skipped, and the printed `state = running`.
Reboot and sign-out survival is unproven: a hosted runner never reboots under the job.
