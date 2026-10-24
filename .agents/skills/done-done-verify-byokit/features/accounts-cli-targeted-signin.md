# Exact managed native sign-in (K1 prerequisite)

Surface: `packages/accounts/src/remote-cli-host.ts` and `cli.ts`, built public `@byokit/accounts/cli`.

## Drive and capture

After building and committing, run `done-done run accounts-cli-targeted-signin`.
The maintained capture `capture/accounts-cli-targeted-signin.mjs` imports the built package,
allocates two empty Claude rows and two empty Codex rows and drives real native subprocess
fixtures at their final isolated folders. No real CLI, credential or account is used.

The app calls `host.start(provider, {account: cliAccountId})`, pastes Claude's synthetic code,
and waits for each selected CLI's status. It checks A stays ready while B signs in, that only
B's store is probed on B re-auth, and that `launchEnv` retains the selected directory.
Unknown A cannot redirect B; overlapping same-provider sign-ins answer busy. Cancelling B
keeps its allocated row and native data even in the creating instance. After a host/roster
restart, B re-auth keeps its original id and folder. Unknown and wrong-provider targets
throw typed refusals without fallback; legacy provider-only start still answers already.

Evidence: `targeted-signin.log` and `steps.json`. Both belong to the same done-done run.
No screen exists for this SDK-only surface.

## Boundaries

This proves host-side target selection and cancellation retention only. The portable phone
start API is unchanged. It does not prove OpenClaw durable bindings, backend execution,
helper delegation, principal duplication/mismatch, native logout, macOS keyring separation
or simultaneous native runs. K1 index/sign-in integration and K2 agent-scoped engine routing
must follow before a consumer can advertise native multi-account execution.
