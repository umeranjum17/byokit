# @byokit/machine

The person's own always-on cloud computer for an app's host process: the kit puts the host on a
computer the person rents on their own account, keeps it running, and says what it costs them, as
their own bill. The person-facing words say "your cloud computer". Nothing here names a machine
provider: the app passes the provider's address, a label to show, and dated price rows
([spec](../../docs/machine-kit.md)).

```ts
import { machine, estimate, stateWords } from '@byokit/machine';

const m = machine({ provider, store });
const ref = await m.create({ name: 'tracker', size: 'small', keepCopies: true });
await m.install(recipe);
await m.state(); // 'on'
```

`machine()` decides where the app's host process runs; the app's one runtime kit
(`@byokit/openclaw` or `@byokit/herdr`) runs inside that process exactly as it does at home.
Model sign-in happens on the machine, inside the aggregator — credentials are never copied from
the person's computer. One person, one provider account, one machine per app install.

Entries: `.` is portable (Node, Electron, React Native); `./ssh` is Node only (an already-rented
Linux machine over the `ssh` binary the app passes by absolute path); `./idle` runs on the machine
inside the host process; `./testing` is Node only (the fake provider and the contract suite).

**Status: in development.** This is the M3 build ([spec](../../docs/machine-kit.md) §14):
frozen types, words, pure parts (`renderUnit`, recipe checks, node argv, cost), `machine()`
for §5.1–5.5 and §5.7 plus install and supervise (§8: `install`, `update`, `host`,
`logs`, `deliver`), the fake provider and the contract suite, the sandbox API adapter
(M4), and the SSH VM adapter (M2). Sleep-and-wake lands in M7, account link in M8.
The package stays private until the recorded real-provider run (M6).

The library reads no environment variable. Every spawned process gets an env built from nothing.

## Recipes

The app supplies its host program and installer as a `HostRecipe`, and the kit writes
and owns exactly one systemd unit per app (`byokit-<name>.service`, `Restart=always`):
a system unit on the sandbox API (only the home and `/etc` survive sleep), a user unit
plus `loginctl enable-linger` on an SSH VM (so the kit needs no root there unless the
recipe asks for it), and a system unit with `User=` when the recipe sets `user`.

**One process per unit.** `run.argv` is one process. An app that needs two (for example
its host and its own relay) passes a wrapper that starts both and exits when either
exits, so `Restart=always` restarts both; systemd's default `KillMode=control-group`
stops every child with the unit.

**The app's own autostart must stay off** so there is exactly one supervisor: the kit's
unit is the only thing that starts the host. The recipe is the app's; keep cron entries,
desktop autostarts and other supervisors out of `install` steps.

**Root steps and `user`.** A recipe may carry `installRoot` argv lists (run as root
before `install` and `update` when the marker is missing; they must be idempotent) and
an optional `user`: a no-sudo user the kit creates, whose home sits inside the machine
user's home (`<machine home>/.users/<user>/`) so it still survives sleep. On a machine
without passwordless sudo, `install` refuses with `needs-root` (the lines to run by
hand in `extra.command`, or no command for a `user` recipe, which needs root on every
install) and leaves the machine untouched.

Secrets never go in `run.env` or `run.argv`: unit files are copied into snapshots and
are readable. Model sign-in happens on the machine, inside the aggregator.
