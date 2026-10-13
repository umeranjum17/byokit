# @byokit/cloud

The person's own always-on cloud computer for an app's host process: the kit puts the host on a
computer the person rents on their own account, keeps it running, and says what it costs them, as
their own bill. The person-facing words say "your cloud computer". The Boat adapter is named
`boat()`; the app passes the provider's address, a label to show, and dated price rows
([spec](../../docs/cloud-kit.md)).

```ts
import { machine, status, type Provider, type MachineStore, type HostRecipe } from '@byokit/cloud';

export async function start(provider: Provider, store: MachineStore, recipe: HostRecipe, show: (s: string) => void) {
  const m = machine({ provider, store });
  const ref = await m.create({ name: 'tracker', size: 'small', keepCopies: true });
  const vars = { app: 'Tracker', label: 'Boat' };
  // Boat's create resolves before the machine is on; poll the one status a phone shows.
  for (let s = await status(m, vars); s.machine !== 'on'; s = await status(m, vars)) {
    show(s.words); // "Setting up your cloud computer. This takes a minute or two."
    if (['failed', 'host-key-changed', 'gone'].includes(s.machine)) return ref;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await m.install(recipe);
  show((await status(m, vars)).words); // "Tracker is running on your cloud computer."
  return ref;
}
```

`status(m, { app, label })` resolves `{ machine, host, words }`: the host is asked only while
the machine is on, and `words` is the one plain sentence to show. Start and stop are
`wake()` and `sleep()`; delete is `remove(ref.id)`.

`machine()` decides where the app's host process runs; the app's one runtime kit
(`@byokit/openclaw` or `@byokit/herdr`) runs inside that process exactly as it does at home.
Model sign-in happens on the machine, inside the aggregator — credentials are never copied from
the person's computer. One person, one provider account, one machine per app install.

Entries: `.` is portable (Node, Electron, React Native); `./ssh` is Node only (an already-rented
Linux machine over the `ssh` binary the app passes by absolute path); `./idle` runs on the machine
inside the host process; `./testing` is Node only (the fake provider and the contract suite).

**Status: in development.** This is the M3 build ([spec](../../docs/cloud-kit.md) §14):
frozen types, words, pure parts (`renderUnit`, recipe checks, node argv, cost), `machine()`
for §5.1–5.5 and §5.7 plus install and supervise (§8: `install`, `update`, `host`,
`logs`, `deliver`), `status()` (§5.9), the fake provider and the contract suite, the Boat adapter
(M4), and the SSH VM adapter (M2). Idle sleep and wake-on-open land in M7 (manual `sleep()` and
`wake()` are already here), account link in M8.
The package stays private until the recorded real-provider run (M6).

The library reads no environment variable. Every spawned process gets an env built from nothing.

## Saved copies, reset and disk space

A machine made with `keepCopies: true` keeps saved copies of itself. `snapshot()` saves one and
keeps only the newest three of the kit's own copies (`snapshot({ keep })` to change it; Boat keeps
10 for free, then bills each). `scheduleSnapshots({ everyMs, onResult })` saves a copy when the newest is
older than `everyMs`, on a timer while the app runs, and resolves `{ stop() }` (await it; it rejects at once on a bad
recipe, a missing machine, or a machine or provider without copies). The kit has no hosted
scheduler, so nothing saves while the app is closed.
`restore(id)` rebuilds the machine from a copy; everything changed since is lost, so the app
confirms first with `words('snapshot.restore', { date })`. A copy that is gone rejects
`no-snapshot`; a save, reset or remove while another of these runs on the same machine rejects `busy`. `disk()` resolves `{ usedGb, totalGb }` for `words('disk.used', ...)`.

```ts
import { words, type Machine } from '@byokit/cloud';

export async function reset(m: Machine, confirm: (s: string) => Promise<boolean>) {
  const [last] = await m.snapshots();
  if (last === undefined || !(await confirm(words('snapshot.restore', { date: last.at.slice(0, 10) })))) return null;
  return m.restore(last.id); // the app then calls url(port) again: the machine is new
}
```

## Boat adapter

`boat({ baseUrl, label, prices, key, fetch?, signal? })` returns the Boat `Provider`. The app
supplies the full API root (including its version path), display label, dated price
rows and a key callback from its own store; the kit has no default provider or URL.
`fetch` is optional. `signal` cancels the provider for good: once aborted, every later call
fails `unreachable`, so build a new `boat()` for the next operation. Setup runs from Node,
Electron or React Native; Boat's CORS rules prevent setup from a web page. Tests use `boat.test`
mapped to a loopback fake.

```ts
import { boat, machine, type MachineStore } from '@byokit/cloud';

export function connect(options: Parameters<typeof boat>[0], store: MachineStore) {
  return machine({ provider: boat(options), store });
}
```

`sandboxApi()` remains a deprecated alias of `boat()` with the same typed options.
The stored provider id stays `sandbox-api`, so existing machine records continue to
work. Credentials, cost rules and the M6 spending and publication gates are
unchanged ([provider contract](../../docs/cloud-kit.md#6-boat-adapter-srcboatts)).

## Your own tailnet

`await m.joinTailnet({ hostname: 'umer-cloud' }, showStep)` installs and starts Tailscale as root.
`showStep` receives `open-page` with the sign-in link (approve it on your phone), or `approve` when the
tailnet must approve the machine (with or without a sign-in link), then `joined` with the MagicDNS name. `await m.tailnet()` reads `joined`, `needs-login`, `needs-approval`, `starting` or `off` without joining.
This slice supports keyless Boat joins only. Passing `authKey` is a typed `unsupported` refusal:
Boat's emulated stdin writes a temporary file, which must never carry a join key.

When there is no TUN device, the daemon uses userspace networking. The app binds its host to
loopback and its root recipe configures `tailscale serve --bg --tcp=<port> tcp://127.0.0.1:<port>`;
joining alone does not expose a service. Advertise the tailnet name, never a provider URL.
Tailscale state stays under `/etc/tailscale` across Boat wakes and is included in disk copies, so a copy currently carries the source's node identity. Clearing it on copies comes with snapshots.
The phone must be on the same tailnet; encrypted pairing is still required.

**SECURITY: No public app port is opened by default.** Create, install, host and join never call
`url()` or `/host`. Explicit `m.url(port)` makes that port public, including opening the provider
firewall. Do not reuse a previously exposed sandbox as a fresh private-only machine: the public
API has no unhost route. Private tailnet reachability and public-port refusal still need live proof.

## Connect an existing Boat computer

Call `provider.list!()` to offer existing computers; never rent another as a fallback.
After the person picks one, show `words('adopt.confirm', { app })`. Only on approval call
`m.adopt(selected, { confirmId: selected.id, recipe })`. It installs and returns the saved
ref, using the recipe's name rather than Boat's display name. No direct store edits are needed.

Adoption checks account, live identity and running state, and refuses existing files,
services, run users or redirected directories rather than taking them over. Choose a fresh
workDir and app name. It does not wake or convert the computer. Its existing snapshot setting
is retained; missing snapshot information disables sleep/copies conservatively.
If installation fails, the selected ref stays saved: retry `m.install(recipe)`, not create
or adopt. The app must keep the same consented recipe for that retry. Installation can execute
the recipe's admin steps; adoption is not a sandbox for an untrusted installer.

## Your own tailnet

`await m.joinTailnet({ hostname: 'umer-cloud' }, showStep)` installs and starts Tailscale as root.
`showStep` receives `open-page` with the sign-in link (approve it on your phone), or `approve` when the
tailnet must approve the machine (with or without a sign-in link), then `joined` with the MagicDNS name. `await m.tailnet()` reads `joined`, `needs-login`, `needs-approval`, `starting` or `off` without joining.
This slice supports keyless Boat joins only. Passing `authKey` is a typed `unsupported` refusal:
Boat's emulated stdin writes a temporary file, which must never carry a join key.

When there is no TUN device, the daemon uses userspace networking. The app binds its host to
loopback and its root recipe configures `tailscale serve --bg --tcp=<port> tcp://127.0.0.1:<port>`;
joining alone does not expose a service. Advertise the tailnet name, never a provider URL.
Tailscale state stays under `/etc/tailscale` across Boat wakes and is included in disk copies, so a copy currently carries the source's node identity. Clearing it on copies comes with snapshots.
The phone must be on the same tailnet; encrypted pairing is still required.

**SECURITY: No public app port is opened by default.** Create, install, host and join never call
`url()` or `/host`. Explicit `m.url(port)` makes that port public, including opening the provider
firewall. Do not reuse a previously exposed sandbox as a fresh private-only machine: the public
API has no unhost route. Private tailnet reachability and public-port refusal still need live proof.

## Recipes

The app supplies its host program and installer as a `HostRecipe`, and the kit writes
and owns exactly one systemd unit per app (`byokit-<name>.service`, `Restart=always`):
a system unit on Boat (only the home and `/etc` survive sleep), a user unit
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
