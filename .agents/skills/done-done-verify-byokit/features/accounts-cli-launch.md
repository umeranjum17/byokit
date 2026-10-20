# Managed CLI launch and move refusals (MS-S3)

## Drive

From the built workspace baseline and Doctor in SKILL.md:

```bash
feature=accounts-cli-launch; entry='@byokit/accounts/cli + @byokit/herdr'
drive=(node .agents/skills/done-done-verify-byokit/capture/accounts-cli-launch.mjs)
```

Run SKILL.md's Evidence capture block (use the dispatched task's external evidence directory when required).
The maintained consumer imports only built public entries, runs an isolated fake Claude CLI as a real child, and drives the existing fake Herdr over its Unix socket. It removes its exclusive short `/tmp/byk-p12-*` directory and stops the fake on exit; no real Herdr lifecycle command is used.

## Feature-map proof route

- `cli-launch-signed-out`: explicit managed id with `loggedIn:false` returns `signed_out`, “Sign in to Umer first.”, and no `set`/`unset`.
- `cli-launch-not-included`: missing binary returns its separate `not_included` code and words without probing.
- `herdr-move-signed-out`: the target's native managed-folder status returns `no`; `moveToAccount` returns `signed_out` plus untouched source `live`; fake world panes and source are byte-equivalent, proving zero pane creates.
- `cli-launch-race`: ready launch, then sign-out before a real child starts; the CLI reports signed out in the selected folder, with provider override absent.
- `herdr-move-race`: the native check answers yes and removes readiness before start; the existing fake queues a start failure. Result is `start_failed`, replacement cleaned, source unchanged.
- `no-default-login`: every actual CLI receipt carries the selected managed folder; Herdr status additionally confines HOME there. No probe retries without that folder.

A passing drive prints actual typed refusal JSON and the race/isolation assertion lines, with exit 0. `--baseline` retains the representative pre-fix journey (missing launch API and signed-out move creating a replacement).

## Limits

Offline SDK/process/socket qualification only: no live login, credential access, paid request, or native Herdr handoff claim. The existing account-panes journeys cover unknown readiness and caller-gated generic move; the extended native-status journey also proves refusal before an opted-in working-source wait.
