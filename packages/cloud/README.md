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

## Hetzner adapter (first slice)

`await hetzner(options)` from `@byokit/cloud/hetzner` returns a Node-only `Provider`
plus `hostKey(ref)`. Pass `baseUrl` (the Hetzner Cloud API root), `label`, a stable
`project` id from the app, `location`, a current Ubuntu/Debian `image` name,
`publicKey` (ed25519), `key` (the app's ephemeral API-token callback), the same
`store` used by `machine()`, and `ssh: { ssh, keyPath, stateDir }` (absolute paths).
The app supplies its own key and token; the adapter never uses ambient credentials.

Sizes and prices are loaded from the API, including IPv4 and excluding VAT. Shared
available types are sorted smallest first; choose `provider.sizes()[0].id`. Creation
uses cloud-init to prepare `/home/user` and public-key SSH; then the unchanged
`m.install(recipe)` bootstraps the host. Before installation, show the fingerprint
from `await provider.hostKey(ref)` and call its `confirm()` only with the person's
approval. SSH is pinned per server; a later changed key is refused, never repinned.

```ts
import { hetzner, type HetznerOptions } from '@byokit/cloud/hetzner';
import { machine } from '@byokit/cloud';

export async function connectHetzner(options: HetznerOptions) {
  const provider = await hetzner(options);
  const m = machine({ provider, store: options.store });
  const ref = await m.create({ name: 'tracker', size: provider.sizes()[0].id, keepCopies: false });
  return { m, ref, hostKey: await provider.hostKey(ref) };
}
```

The token is project-scoped, but Hetzner has no account-read endpoint: `project` is
an app-supplied identity, not API-verified. Saved refs are also checked with this
token through `/servers/{id}`. A 404 is treated as a server deleted in the console:
`account()` accepts its ref so `remove()` can forget it and sweep its unused firewalls,
while `status()` and `state()` keep rejecting `wrong-account` until then. Known limit:
Hetzner answers 404 for a server outside the current token's project too, so a token
from another project under the same app project id makes a live server look deleted;
keep the app project id in step with the token. Create retries
reconcile by unique name plus operation label. Create makes a dedicated Hetzner Cloud
Firewall **before** the server and attaches it in the server-create request: its only
inbound rule is **SSH 22/tcp on IPv4**. Every app port stays closed publicly; recipe
installation never adds a rule. SSH-only firewall ownership/rules are checked before
SSH operations. Tailnet-only SSH is a later step; public SSH 22 remains for bootstrap.

If attachment or subsequent setup fails, the adapter deletes the allocated server,
its primary IPs and firewall, then returns a typed failure. If cleanup itself fails,
`extra.machine`, `extra.firewall` and `extra.operation` identify the remaining cleanup
scope; do not provision a replacement until that cleanup is completed. Delete confirms
the server, automatically allocated primary IPs and dedicated firewall are gone;
changed IP ownership/auto-delete refuses deletion.

This slice offers create, status, SSH exec/write, host bootstrap and confirmed delete.
It refuses `keepCopies: true` and enables **no paid backups or snapshots**. Start/stop
are a follow-up. **A stopped Hetzner server still bills**; stopping is not deletion or
a backup. API prices remain a list estimate, not an invoice. `machine.cost()` uses
the selected size's monthly cap (or the app's entered amount); it does not measure
elapsed Hetzner spend. `provider.url`, usage, plan and scoped keys are absent.

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
