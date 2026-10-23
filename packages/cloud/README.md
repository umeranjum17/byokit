# @byokit/cloud

The person's own always-on cloud computer for an app's host process: the kit puts the host on a
computer the person rents on their own account, keeps it running, and says what it costs them, as
their own bill. The person-facing words say "your cloud computer". The Boat adapter is named
`boat()`; the app passes the provider's address, a label to show, and dated price rows
([spec](../../docs/cloud-kit.md)).

```sh
npm install @byokit/cloud
```

```ts
import { setup, words, type HostRecipe, type MachineStore, type Provider } from '@byokit/cloud';

export async function start(provider: Provider, store: MachineStore, recipe: HostRecipe, show: (s: string) => void) {
  const vars = { app: 'Tracker', label: 'Boat' };
  // Rents a new computer on the person's own provider account, waits until it is on, then installs.
  for await (const s of setup({ provider, store, recipe, create: { size: 'small', keepCopies: true } })) {
    show(s.step === 'failed' ? words(s.cause, vars) : words(`setup.${s.step}`, vars));
    if (s.step === 'ready') return s.ref; // "Tracker is running on your cloud computer."
  }
  return null; // failed: run the same setup() again and it resumes on the saved computer
}
```

The new computer bills the person's own provider account, never the app, so the app shows `estimate()`'s words and asks before it calls `setup({ create })`.
`status(m, { app, label })` resolves `{ machine, host, words }`: the host is asked only while
the machine is on, and `words` is the one plain sentence to show. Start and stop are
`wake()` and `sleep()`; delete is `remove(ref.id)`.

`machine()` decides where the app's host process runs; the app's one runtime kit
(`@byokit/openclaw` or `@byokit/herdr`) runs inside that process exactly as it does at home.
Model sign-in happens on the machine, inside the aggregator — credentials are never copied from
the person's computer. One person, one provider account, one machine per app install.

Entries: `.` is portable (Node, Electron, React Native), including the HTTPS-only Hetzner adapter,
the one-line console install and `sshVm()` over the app's own SSH transport; `./ssh` is Node only
(the same adapter over the `ssh` binary the app passes by absolute path); `./hetzner` is Node only
(the Hetzner Cloud first slice below, with SSH); `./idle` runs on the machine inside the host process;
`./testing` is Node only (the fake providers and the contract suite).

**Status: in development.** This is the M8 build ([spec](../../docs/cloud-kit.md) §14):
frozen types, words, pure parts (`renderUnit`, recipe checks, node argv, cost), `machine()`
for §5.1–5.5 and §5.7 plus install and supervise (§8: `install`, `update`, `host`,
`logs`, `deliver`), `status()` (§5.9), the fake provider and the contract suite, the Boat adapter
(M4), reach over plain SSH to the machine's loopback (§9.1), the SSH VM adapter (M2) over the `ssh` binary or the app's own transport, the Hetzner first slice,
and account link (`claim()`, §11.5). Idle sleep and wake-on-open land in M7 (manual `sleep()` and
`wake()` are already here).
`claim()` passed a recorded live sign-in against Boat on 2026-10-18 (discover, register, link
and code, key, then `revokeClaim()`, after which Boat refused the key). Releases publish
on the npm `latest` tag (from 0.2.1). Create, install and hosting with a claimed key are still
unproven until M6's recorded run, so an app keeps `setup.makeKey` as its fallback until that run passes.
Our later live Boat runs make no new claim: they use the fleet's saved Boat key, never print,
log, commit or revoke it, and delete only the machines they made.

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
  return m.restore(last.id); // the machine is new: the app reads its SSH route again before it dials it
}
```

## Undo an update

On a machine that keeps copies (Boat with `keepCopies: true`), `update(recipe)` first saves a copy
from just before the update and resolves `{ undo, pruneError? }`; the next update replaces that copy,
and `snapshot()`'s pruning never counts or deletes it. The copy takes a few minutes and needs a spare
free copy or credit: when Boat refuses, `update` rejects `balance` (`extra.why: 'copies'`, words
`copies.noCredit`) and changes nothing. `update(recipe, { undo: false })` updates without a copy; a
Hetzner server or an SSH box resolves `{ undo: null }` and rejects `unsupported` for `{ undo: true }`.
An update step that fails after the copy rejects with `extra.undo` set to the copy's id.
`undoPoint()` resolves that copy (or `null`), and `undoUpdate(recipe)` resets the machine to it, as
`restore` does (on Boat a new machine with a new id), so everything changed since the copy is lost,
not only the update. With no such copy it rejects `no-undo`. Undo is not yet proven on a real Boat
computer.

```ts
import { words, type HostRecipe, type Machine } from '@byokit/cloud';

export async function undo(m: Machine, recipe: HostRecipe, confirm: (s: string) => Promise<boolean>) {
  const point = await m.undoPoint();
  if (point === null || !(await confirm(words('update.undo', { date: point.at.slice(0, 10) })))) return;
  await m.undoUpdate(recipe); // the old host version runs again; the app records which recipe that is
}
```

## Boat adapter

`boat({ baseUrl, label, prices, key, fetch?, signal? })` returns the Boat `Provider`. The app
supplies the full API root (including its version path), display label, dated price
rows and a key callback from its own store; the kit has no default provider or URL.
`fetch` is optional. `signal` cancels the provider for good: once aborted, every later call
fails `unreachable`, so build a new `boat()` for the next operation. Setup runs from Node,
Electron or React Native; Boat's CORS rules prevent setup from a web page. Tests use `boat.test`
mapped to a loopback fake. Boat's public API has no region or location, so the kit has no region
option for Boat and the app shows none; Boat picks where the computer runs.

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
keep the app project id in step with the token. An unreachable or 5xx create response
is reconciled by unique name plus operation label before cleanup. Create makes a dedicated
Hetzner Cloud Firewall **before** the server and attaches it in the server-create request: its only
inbound rule is **SSH 22/tcp on IPv4**. Every app port stays closed publicly; recipe
installation never adds a rule. Exec/write/hostKey require the attached, applied
SSH-only app firewall; a typed `provider` refusal says to re-attach it or remove the
machine. Public SSH 22 is key-only with the pinned host key, and it is also how the phone reaches the app
(an SSH forward to the machine's loopback, below).

If attachment or subsequent setup fails, the adapter deletes the allocated server,
its primary IPs and firewall, then returns a typed failure. If cleanup itself fails,
`extra.machine`, `extra.firewall` and `extra.operation` identify the remaining cleanup
scope; do not provision a replacement until that cleanup is completed. Delete confirms
the server and automatically allocated primary IPs are gone, then sweeps every
unused kit-labelled firewall for that machine name, attached or detached before
deletion. Firewall changes never block server removal; changed IP ownership/auto-delete
still refuses deletion.

This slice offers create, status, SSH exec/write, host bootstrap and confirmed delete.
It refuses `keepCopies: true` and enables **no paid backups or snapshots**. Start/stop
are a follow-up. **A stopped Hetzner server still bills**; stopping is not deletion or
a backup. API prices remain a list estimate, not an invoice. Without usage,
`machine.cost()` uses the app's `monthlyEntered` amount or the first (smallest) price's
monthly cap; record a larger selected size's cap explicitly. It does not measure
elapsed Hetzner spend. `provider.url`, usage, plan and scoped keys are absent.

## Hetzner from the phone alone (first boot)

`await hetznerApi(options)` from `.` is the same adapter over HTTPS only, so it runs in React Native:
create, status, confirmed delete and the catalogue, with no SSH and no `node:*` import. Pass
`firstBoot: { recipe, phoneKey }` and cloud-init installs the recipe on the server's first boot:
the pinned Node (SHA256 checked), the install steps, the system unit, and the owner phone's public
key in `<workDir>/.byokit/inbox/phone.bin` before the host starts (§5.12). `recipe.name` must equal
the machine name, and `workDir` may start with `~/`. The provider token never enters cloud-init.

```ts
import { hetznerApi, machine, type HetznerApiOptions, type HostRecipe } from '@byokit/cloud';

export async function rentFromPhone(options: HetznerApiOptions, recipe: HostRecipe, phoneKey: Uint8Array, size: string) {
  const provider = await hetznerApi({ ...options, firstBoot: { recipe, phoneKey } });
  const m = machine({ provider, store: options.store });
  return m.create({ name: recipe.name, size, keepCopies: false }); // installs itself; exec and write reject 'unsupported'
}
```

Pass the phone's own SSH public key (the login key its SSH module holds) as `publicKey`: SSH 22/tcp
opens as in the Node slice and cloud-init authorizes that key, so once `status()` reads `on` the app
confirms the host key with `sshHostKey({ transport, pins, host: provider.address(ref) })` and reaches the
app through an SSH forward. Without `publicKey` the firewall lets **nothing** in, and the computer has no
reach until the person adds a key. The phone cannot see the install: `status()` reads `on` while it still runs, and the
host's first answer on its own link is the ready signal. Full Hetzner power stays typed:
`server` adds `POST /servers` fields (`ssh_keys`, `volumes`, `networks`, `labels`, IPv6 and others;
the kit's own fields win), `cloudConfig` adds cloud-config keys (its `users` follow the kit's `user`; its `write_files` and
`runcmd` come before the kit's install), and `provider.request(method, path, body)` makes any
other Hetzner Cloud call with the same key, masking and typed errors. The Node `hetzner()` is this
adapter plus SSH exec and write, unchanged. Hetzner bills the person's own account per hour up to
the monthly cap, as usage, not a subscription; a stopped server still bills.

## One line on a console

`setupCommand(recipe, { phoneKey?, returnFile? })` from `.` returns `{ command, script, ready }`:
one line to paste into the person's own computer's terminal or any provider's web console. It runs
the same install as the first boot (as root: a system unit; as the person: a user unit with
linger; root steps use `sudo`). A good run ends with exactly `ready` (`byokit-ready <name>`),
followed by the first line of `<workDir>/.byokit/outbox/<returnFile>` when the host writes one
within 60 s, such as the app's own pairing code. A failed run ends `byokit-failed <name> <step>`
with exit 1. Pasting it again repairs in place. `script` is the readable text the line decodes,
for the app to show; a truncated paste runs nothing. `installScript(recipe, o)` is that text alone,
for another provider's user-data box.

## Reach is SSH, never your tailnet

Tailscale is for your own devices only, such as your computer and phone. A cloud or sandbox computer
never joins your tailnet: the app's host listens on the machine's loopback, and the device reaches it
through one SSH forward, with a pinned host key and the device's own SSH key
([spec §9](../../docs/cloud-kit.md#9-reach-from-phone-and-web)). Encrypted pairing still runs inside it.
`setup()`'s `securing` step proves that route (below); `sshResolve()` dials it.

A computer that 0.2.x to 0.4.0 joined to your tailnet leaves it on its next `install()` or `update()`:
the kit signs it out of Tailscale and removes its own `tailscaled` service, its drop-in and the node
identity in `/etc/tailscale`. A Tailscale you installed yourself (no kit drop-in) is never touched. Remove
such a computer on your Tailscale admin page as well, and delete its saved copies made after it joined:
they hold that identity.

**SECURITY: No public app port is opened by default.** Create, install, host and securing never call
`url()` or `/host`. Explicit `m.url(port)` makes that port public, including opening the provider
firewall. Do not reuse a previously exposed sandbox as a fresh private-only machine: the public
API has no unhost route.

## Any SSH box from a phone

A phone has no `ssh` binary, so `.` takes the app's own SSH module as a transport. The kit quotes every
command, wraps it in `timeout` (and `sudo -n` for root), checks the host key and maps errors; the
transport only connects, runs one command line and reads the server's key. The login key stays in the
app's transport and never reaches the kit.

```ts
import { machine, pairEnrol, setup, sshHostKey, sshVm } from '@byokit/cloud';
import type { HostRecipe, MachineStore, SetupStep, SshForward, SshTarget, SshTransport } from '@byokit/cloud';
// The app's own parts: its SSH module, its secure store, recipe and screen.
declare const mySsh: {
  run(to: SshTarget, command: string, input: Uint8Array | undefined, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
  serverKey(host: string, port: number): Promise<{ fingerprint: string }>;
  localForward(to: SshTarget, remotePort: number): Promise<SshForward>;
};
declare const secure: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> };
declare const store: MachineStore, recipe: HostRecipe, phoneKey: Uint8Array, show: (s: SetupStep) => void;

const transport: SshTransport = {
  // Before logging in, refuse a server whose key is not `to.fingerprint`:
  // throw new MachineError('host-key', …). Give up at timeoutMs + 15 s with timedOut: true.
  exec: (to, command, { input, timeoutMs }) => mySsh.run(to, command, input, timeoutMs), // { code, stdout, stderr }
  hostKey: ({ host, port }) => mySsh.serverKey(host, port),  // { fingerprint: 'SHA256:…' }
  forward: (to, remote) => mySsh.localForward(to, remote.port), // 127.0.0.1:<localPort> here to remote.port on the box
  // write: optional (e.g. SFTP); without it the kit writes through exec's stdin.
};
const pins = { load: () => secure.get('box-key'), save: (f: string) => secure.set('box-key', f) };
const box = { transport, pins, host: '203.0.113.7', user: 'ada', label: 'My server' };

const key = await sshHostKey(box);           // show key.fingerprint; compare it with the provider console
await key.confirm();                         // only on the person's yes
const provider = sshVm(box);
const m = machine({ provider, store });
for await (const step of setup({
  provider, store, recipe, pick: (listed) => listed[0], confirmId: key.fingerprint,
  address: { port: 7300, transport, target: { host: '203.0.113.7', user: 'ada' }, pins },
  pair: pairEnrol(m, recipe, phoneKey),
})) show(step);                              // checking-access, listing, inspecting, installing, securing, pairing, ready
```

`sshVm()` lists the one box it points at, so the existing-computer checks (`adopt.confirm` consent, no
takeover of existing files) apply. The `securing` step proves the SSH route to the app port on the
box's loopback (it needs the transport's `forward`, below): nothing is installed for it, nothing public
is opened, and pairing stays encrypted. A changed host key is refused, never repinned. On Node, `@byokit/cloud/ssh`
accepts the same options and defaults to the `ssh` binary. `fakeSshTransport()` from `./testing` stands
in for the app's SSH module in its tests.

### Reaching the app over SSH

The app port can stay on the machine's loopback: a transport with the optional `forward(to, { host: '127.0.0.1', port })`
carries each connection there (an SSH local forward; the same host-key rule as `exec`) and resolves
`{ localPort, close(), closed }`. `sshResolve({ transport, pins, target: { host, port?, user }, port })` turns it into a
`Dial.resolve` for `@byokit/pair`: it opens one forward before the first dial, reuses it while it is up, opens a new one
after it drops, and rewrites `ws://127.0.0.1:<port>…` to the forward's local port (other addresses pass through).
`close()` on the result ends the forward.

```ts
import { sshResolve } from '@byokit/cloud';
import type { SshPins } from '@byokit/cloud';
import { sshTransport } from '@byokit/cloud/ssh'; // Node: your `ssh` binary and key file; `forward` is `ssh -N -L`
import { DeviceLink, type DeviceGrant, type DeviceStore } from '@byokit/pair';
declare const keyPath: string, stateDir: string, pins: SshPins, grant: DeviceGrant, store: DeviceStore;
const transport = sshTransport({ ssh: '/usr/bin/ssh', keyPath, stateDir });
const resolve = sshResolve({ transport, pins, target: { host: '203.0.113.7', user: 'ada' }, port: 7300 });
const link = new DeviceLink(grant, { store, resolve }); // grant.urls: ['ws://127.0.0.1:7300']
```

On a phone the app's own SSH module supplies `forward`. `fakeSshTransport()` implements it in-process: put the machine
port and a real local port in its `loopback` map.

Billing: the kit adds nothing. The person pays their server provider as before; a model sign-in on the
machine is still the runtime kit's, with subscription and API-key routes labelled as such there.

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

## More than one account or computer

`machine()` holds one computer. For a person with several Boat accounts or computers, `roster()` keeps a
non-secret list of accounts in your own `RosterStore` (a `load`/`save` pair, like `MachineStore`) and each
account's key in your secure key store (`KeyStore`: `get`, `set`, `delete` by account id).

```ts
import { boat, roster } from '@byokit/cloud';
import type { KeyStore, Price, RosterStore } from '@byokit/cloud';

declare const rosterStore: RosterStore, keyStore: KeyStore, baseUrl: string, prices: Price[];
declare const pastedKey: string, otherKey: string, homeId: string;

const r = roster({
  store: rosterStore,   // { load, save } for a non-secret record
  keys: keyStore,       // { get, set, delete }: your keychain or SecureStore
  provider: ({ label, key }) => boat({ baseUrl, label, prices, key }),
});

await r.add({ key: pastedKey, label: 'Work' });   // checked with the provider, key to keyStore
await r.add({ key: otherKey, label: 'Home' });    // the first account added is active
await r.select(homeId);                           // the active account
const computers = await r.list();                 // refs with subdomain, state, latestSnapshot where Boat returns them
await r.manage(computers[0]);                     // keep its identity, pinned to its account
const m = await r.machine(computers[0].id);       // a Machine: wake, sleep, snapshot, remove touch only this one
await m.sleep();
const made = await (await r.fresh()).create({ name: 'web', size: 'small', keepCopies: true });  // joins the roster
await r.remove(homeId);                           // forgets the account, its key and its machines; computers stay
```

Every account has its own `Provider` (`r.provider(id)`), so a key or a failure on one account never reaches
another. `r.machines()` lists the managed computers, each with its `account`. A computer that is not managed
rejects `no-machine`; an account not on the roster rejects `wrong-account`. An app with one account keeps
calling `machine()` as before.

## Setup step stream

`setup({ provider, store, recipe, pick, confirmId, onLine, address, pair })` drives one existing-computer
connect as steps for the connect screen: `checking-access`, `listing`, `inspecting` (the picked machine
passed the adoption guards and is saved), `installing` (`onLine` carries its lines), `securing` (the
SSH route to the app, with `address: { port, transport, publicKey?, target?, pins? }`; skipped without
`address`), `pairing` (the app's Pair-ready gate; skipped without `pair`), then `ready`. Each step is emitted after its real result, shown
with `words('setup.<step>', { app, label })`. A rejection ends the stream with one `failed` step (`at` the
phase, `cause` a words key via `errorKey`, `retryable` whether a repeat may pass): re-run `setup()` with
the same arguments and it resumes at install on the saved machine instead of renting another.

Securing finds where to log in, then proves the route without installing or opening anything. On Boat,
`provider.sshAccess(ref, address.publicKey)` lets the device's public key in and names the host key to pin;
elsewhere (an SSH box, Hetzner) the app passes `address.target` and the `pins` it confirmed with
`sshHostKey`. The transport's `hostKey()` must match that pin (else `host-key`), something must listen on
`127.0.0.1:<port>` on the machine (else `provider`, retryable: the host is still starting), and one
`forward` must open (`unreachable` when refused; a transport without `forward` is `unsupported`). The step
carries `route`, `{ host, port, user, fingerprint, appPort }`, and the pair gate gets the machine's loopback
root `ws://127.0.0.1:<port>` as `ctx.urls` and the route as `ctx.ssh`. The recipe binds its host to
`127.0.0.1:<port>`, never `0.0.0.0`. On Node with Boat, `sshTransport()` pins through its `known_hosts`, so
confirm `sshHostKey({ ssh, host, port, stateDir })` against the fingerprint `sshAccess` names first.

For a person with no computer yet, pass `create: { size, keepCopies }` instead of `pick` and
`confirmId`: after `checking-access` the kit rents one named after the recipe, waits until it is on
(Boat's create answers while it is still starting), and emits `creating` (`setup.creating` words) before
`installing`; the rest is the same. The recipe is checked before the rental, so a refused recipe never
bills. A retry with the same arguments finds the saved computer and resumes on it. The kit saves the
create's idempotency key in the store (`record.pending`) before it asks the provider, so even when the
answer is lost, or the app restarts, the retry gets back the computer already made instead of renting a
second one. A retry with another size is refused while that create is pending.

```ts
import { setup, words, type HostRecipe, type MachineRef, type MachineStore, type Provider } from '@byokit/cloud';

export async function connect(
  provider: Provider, store: MachineStore, recipe: HostRecipe,
  pick: (listed: MachineRef[]) => MachineRef, confirmId: string,
  pair: (ref: MachineRef) => Promise<void>, show: (s: string) => void,
) {
  const vars = { app: 'Tracker', label: 'Boat' };
  for await (const s of setup({ provider, store, recipe, pick, confirmId, pair })) {
    show(s.step === 'failed' ? words(s.cause, vars) : words(`setup.${s.step}`, vars));
  }
}
```

## Enrol the owner's phone

`pairEnrol(m, recipe, phoneKey)` is the `setup()` `pair` gate for exact-phone enrollment: it hands
the one authenticated phone's 32-byte public key to the machine through provider delivery
(`deliverPhoneKey`, inbox file `phone.bin` at 0600), and the machine's host process binds it with
`Host.enrol` (`bindPhoneKey`). No new pairing crypto, and the key never travels in `run.env`,
`run.argv`, logs or error text, so the recipe guard keeps refusing `KEY`-looking names unchanged.
The first phone wins and the binding survives restarts: the same key rebinds idempotently while any
other key is refused. Shown with the existing `setup.pairing` words.

After binding, the host writes `phoneReceipt(host, key)` to `<workDir>/.byokit/outbox/receipt.json`.
`pairEnrol` waits up to a minute for that receipt for the same key and the `pairing` step carries it:
the host's public key, the phone's device on it, the address on the machine, and the SSH route to it.
The phone opens a real `@byokit/pair` link with that receipt, its own secret key and its SSH transport
alone. Every value in it is public. The receipt's `urls` are the machine's loopback root,
`ws://127.0.0.1:<port>`, dialled through `sshResolve` over `receipt.ssh`; an app whose link route has a
path passes `pairEnrol(m, recipe, key, { url: (root, host) => ... })` to build it from each root and the
host's public key.

`EnrolHost`, `OwnerHost` and `ReceiptHost` are structural: the `@byokit/pair` `Host` fits, and so does an
app's own device store that keeps the authority itself, as long as it answers `devices()`, `enrol()`
(and `revoke()`, `keys`) the same way.

```ts
import { machine, pairEnrol, setup, sshResolve, type HostRecipe, type MachineRef, type MachineStore, type Provider, type SshTransport } from '@byokit/cloud';
import { DeviceLink, b64url, type KeyPair } from '@byokit/pair';

// On Boat: `sshPublicKey` is the OpenSSH public line of the login key `ssh` (the app's SSH module) holds.
export async function connectPhone(
  provider: Provider, store: MachineStore, recipe: HostRecipe,
  pick: (listed: MachineRef[]) => MachineRef, confirmId: string, phone: KeyPair, ssh: SshTransport, sshPublicKey: string,
) {
  const m = machine({ provider, store });
  let link: DeviceLink | undefined;
  for await (const s of setup({
    provider, store, recipe, pick, confirmId, pair: pairEnrol(m, recipe, phone.publicKey),
    address: { port: 7300, transport: ssh, publicKey: sshPublicKey },
  })) {
    if (s.step === 'pairing' && s.receipt?.ssh) {
      const route = s.receipt.ssh;
      const resolve = sshResolve({ transport: ssh, pins: { load: async () => route.fingerprint }, target: route, port: route.appPort });
      link = new DeviceLink({ v: 1, secretKey: b64url(phone.secretKey), hostName: 'Your cloud computer', ...s.receipt },
        { store: { save() {}, clear() {} }, resolve });
    }
    if (s.step === 'ready') return link;
    if (s.step === 'failed') throw new Error(s.at);
  }
  throw new Error('connect ended without ready');
}
```

On the machine, `takeInbox(workDir, file)` and `writeOutbox(workDir, file, text)` from
`@byokit/cloud/unit` (Node) are the host's side of that hand-off: the first resolves the delivered
bytes and a `done()` that removes the file (call it only after handling resolves), or `null` while
absent; the second writes at 0600 through a temporary name and a rename.

From the app, `machine.run(recipe, argv, { timeoutMs?, input? })` runs one command on the computer the
way the host's unit sees it (as the recipe's user, in `workDir`, with the kit's Node first on `PATH` and
`recipe.run.env` set) and resolves the full `ExecResult`; a non-zero exit is the app's to read. It
never installs a missing Node (it rejects `provider`). `machine.newest(recipe, prefix)` resolves the
newest `<workDir>/.byokit/outbox/<prefix>*` file as `{ file, text }`, or `null` while none exists.

For a command that writes an offer under a name it picks and then waits for the phone's answer,
`machine.handoff(recipe, argv, { prefix, timeoutMs? })` removes old `<prefix>*` outbox files (an
interrupted run's offer is never read as this one's), starts `argv` as `run` does (10 minutes by
default), and resolves `{ offer, deliver, done }`: `offer` yields each new or rewritten `<prefix>*` file
as `{ file, text }` until the command ends, `deliver(file, bytes)` writes the answer to the inbox, and
`done` is the command's `ExecResult`. The `setup()` `pair` gate gets both as `ctx.run(argv, o?)` and
`ctx.handoff(argv, o)`, bound to the setup recipe (optional in the type, so a gate an app calls with
its own context still type-checks; `setup()` always passes them).

```ts
import type { PairContext } from '@byokit/cloud';

export async function pairByHandoff(ctx: PairContext, answer: (offer: string) => Promise<{ file: string; bytes: Uint8Array }>) {
  const h = await ctx.handoff!(['my-app', 'pair', '--handoff'], { prefix: 'my-app-pair-' });
  for await (const offer of h.offer) {
    const { file, bytes } = await answer(offer.text); // e.g. the words file the offer names
    await h.deliver(file, bytes);
  }
  const out = await h.done;
  if (out.code !== 0) throw new Error(out.stderr);
}
```

```ts
import { PHONE_KEY_FILE, RECEIPT_FILE, bindPhoneKey, phoneReceipt } from '@byokit/cloud';
import { takeInbox, writeOutbox } from '@byokit/cloud/unit';
import { Host } from '@byokit/pair';

export async function bindOwner(host: Host, workDir: string) {
  const got = await takeInbox(workDir, PHONE_KEY_FILE);
  if (got === null) return null; // nothing delivered yet: check again later
  const bound = await bindPhoneKey(host, got.bytes, 'Phone'); // { id, bound }: false when this phone was already bound
  await writeOutbox(workDir, RECEIPT_FILE, phoneReceipt(host, got.bytes));
  await got.done();
  return bound;
}
```

A reinstalled app or a new phone has an empty store, so `setup()` on the person's own computer ends
`failed` with cause `error.ownerEnrolled` (not retryable) and changes nothing. Show that sentence and
ask the person; only after they confirm, run the same `setup()` with `replaceOwner: true`. It
reinstalls in place and the `pairEnrol` gate delivers the key as `owner.bin` (`OWNER_KEY_FILE`). On
the machine, call `replacePhoneKey` for that file only, never for anything a paired device or the
network sent: it revokes the old phone's grant, then binds the new key; write its receipt as above. Remove an inbox file only
after its call resolves, so a crash part-way is finished on the next start.

```ts
import { OWNER_KEY_FILE, PHONE_KEY_FILE, bindPhoneKey, replacePhoneKey } from '@byokit/cloud';
import { Host } from '@byokit/pair';

export async function handleInbox(host: Host, file: string, delivered: Uint8Array) {
  if (file === OWNER_KEY_FILE) return replacePhoneKey(host, delivered, 'Phone'); // the owner confirmed on the setup device
  if (file === PHONE_KEY_FILE) return bindPhoneKey(host, delivered, 'Phone');   // first phone wins
  return null;
}
```

## Link without pasting a key

`claim({ baseUrl, email })` links the provider account through the provider's own
sign-in: it yields `open-page` with the sign-in link, then `type-code` with the code the
person types there (the code never comes back), then `waiting` while the provider is
polled, then `done` with the key, its expiry and scopes. Save the key as
`MachineRecord.providerKey`. There is no refresh: when it nears expiry, `keyWords` warns
and the app runs `claim()` again. A `failed` step ends the run; show `claim.refused` for
`refused`, `claim.expired` for `expired`, `state.unknown` for `unreachable` and
`state.failed` for `provider`, or fall back to `setup.makeKey`.
Before `done`, `claim()` revokes the spare sign-in assertion sent beside the key.
`revokeClaim({ baseUrl, key })` ends a claimed key (RFC 7009) and rejects with a
`MachineError` naming the cause.

```ts
import { claim, words } from '@byokit/cloud';

export async function link(baseUrl: string, email: string, open: (url: string) => void): Promise<string | null> {
  for await (const s of claim({ baseUrl, email })) {
    if (s.step === 'open-page') open(s.url);
    else if (s.step === 'type-code') open(s.url); // show s.code beside it for the person to type
    else if (s.step === 'done') return s.key;
    else if (s.step === 'failed' && s.why === 'expired') open(words('claim.expired', { label: 'Boat' }));
  }
  return null;
}
```

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
