<h1 align="center">@byokit/openclaw</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/openclaw"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/openclaw?style=flat" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
</p>

<p align="center"><strong>The OpenClaw runtime kit: one object that runs the pinned engine for your app.</strong><br/>
It drives the pinned OpenClaw engine (<code>openclaw@2026.8.1</code>, protocol 4) through one kit object. The
aggregator's full operator surface stays available as typed pass-through calls (<code>call</code> for every operator
method, <code>callDynamic</code> for the rest), with plain-words helpers for members, sign-in, runs, approvals and
config. For apps built on OpenClaw, where the engine holds the subscriptions.</p>

## Install

```sh
npm install @byokit/openclaw
```

[![npm](https://img.shields.io/npm/v/@byokit/openclaw?style=flat&label=)](https://www.npmjs.com/package/@byokit/openclaw) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=openclaw-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

Node 22.18 or later. The kit brings the engine with it: the first `start()` installs the pinned `openclaw@2026.8.1`
under your `stateDir` (a few minutes, needs the network once), and later starts run from there. For a whole app, a
phone page that pairs, signs in with ChatGPT, runs and answers approvals, see
[`examples/openclaw-kit`](../../examples/openclaw-kit).

## Quickstart

Start the engine, add a member, sign them in with a subscription, run a message (typechecked; running it installs
the pinned engine and needs a real ChatGPT sign-in, so it is not run here):

```ts
import { OpenClawKit } from '@byokit/openclaw';

const kit = new OpenClawKit({ stateDir: './openclaw-state', config: { plugins: { allow: ['openai'] } } });
await kit.start(); // installs the pinned engine under stateDir, spawns it, connects

await kit.ensureMember('umer');
const controller = new AbortController(); // call controller.abort() when Umer cancels
const signIn = kit.signIn('umer', {
  authChoice: 'openai-device-code', via: 'code', signal: controller.signal,
}, (view) => { if (view.code) console.log('Open', view.url, 'and enter', view.code); });
const signedIn = await signIn.done;
if (signedIn.state !== 'done') {
  console.log(signedIn.error); // plain words; why is 'expired' or 'declined' on expiry or cancellation
  await kit.stop();
  process.exit(0);
}

const end = await kit.run(
  { member: 'umer', sessionKey: 'agent:umer:main', message: 'Say hello.' },
  (e) => { if (e.type === 'text') console.log(e.text); },
);
console.log(end);
await kit.stop();
```

Device approval can take longer than two minutes. The kit waits through the engine's advertised code lifetime
(`expiresInMinutes` on the pin, or `expires_in` seconds when supplied), including progress pulls. If the engine
supplies no lifetime, it owns the deadline. Ordinary wizard requests keep their 120-second timeout.
`signIn.cancel()` or the optional caller `signal` cancels this sign-in and releases its wizard session.
`done` returns a typed `SignInView`: `why: 'expired'` for an expired code, `why: 'declined'` for cancellation,
with a plain sentence in `error`. `SignInOptions` is exported from the host entry.

To choose which of a member's accounts a run uses, pass `model: 'provider/model'` in the run spec (for example
`'openai/gpt-5.1'`, where `provider` is an id `kit.providers(member)` lists). That provider is the one called and billed for this run only, with no fallback to another
provider or model. If the member isn't signed in to it, the run ends `{ ok: false, kind: 'signed-out' }` and the
engine is never called. Leave `model` out to keep the engine's own choice. A specific sign-in (`@profile`) can't be
picked per run: the pinned engine may still switch to another sign-in for the same provider.

A run spec also takes `system`, `images` (`{ data, mimeType }[]`), `thinking` and `tools`, a subset of the app tools
(`KitOptions.tools` names) this run may call; any other app tool is refused at the gate before `ToolHost.gate` sees
it. Tool events carry the engine's call `id`, the `input` on `start` and the `output` and `error` on `end`. A run that
ends ok carries `usage` (the engine's token total for the run, and `costUsd` when it priced the model) and
`planWindow` (the subscription's quota windows as the engine last read them), each only when the engine reports it.
`openclawDevice(link).run(message, o)` takes the same options over the link, and `state()` adds the kit and engine
versions and the providers the device's member is signed in to.

The same kit runs offline against the fake Gateway from `@byokit/openclaw/testing` (no engine, no network, no
account), and lists the sign-in routes it offers:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync(join(tmpdir(), 'openclaw-readme-'));
const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: fakeGateway().factory });
try {
  await kit.start();
  console.log('state:', kit.state.phase, '| protocol:', kit.hello?.protocol);
  await kit.ensureMember('umer');
  const end = await kit.run(
    { member: 'umer', sessionKey: 'agent:umer:main', message: 'Say hello.' },
    (e) => console.log('event:', JSON.stringify(e)),
  );
  console.log('end:', JSON.stringify(end));
  for (const r of kit.routes().filter((r) => r.offer))
    console.log(`route: ${r.choice.padEnd(26)} ${r.billing.padEnd(12)} ${r.via}`);
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
```

Its output, run from this repo with Node:

```text
state: ready | protocol: 4
event: {"type":"text","text":"fake: Say hello."}
event: {"type":"text","text":"fake: Say hello."}
end: {"ok":true,"text":"fake: Say hello.","usage":{"input":10,"output":16,"total":26}}
route: openai                     subscription browser
route: openai-device-code         subscription code
route: xai-oauth                  subscription code
route: github-copilot             subscription code
route: github-copilot-enterprise  subscription code
route: minimax-global-oauth       subscription code
route: minimax-cn-oauth           subscription code
```

Every offered route is a subscription sign-in. Each `Route` carries `billing` (`subscription`, `api` or `local`), so
an app labels any other route it shows; API-billed routes are not offered by default.

## API at a glance

Entries:

- `.` is the host side: `OpenClawKit`, engine supervision, config invariants, approvals (Node).
- `./device` is the portable client for phones and browsers (no Node imports).
- `./link` is the host-side `@byokit/link` adapter: member-checked ops, sealed approval push (Node).
- `./testing` holds `fakeGateway`, the `openclawContract` suite and the scripted model stub.

| Export | What it does |
| --- | --- |
| `OpenClawKit` (`.`) | Prepares, starts, supervises and stops the engine. `call` / `callDynamic` pass through to the Gateway, `onEvent` listens. Helpers: `ensureMember`, `routes`, `providers`, `signedIn`, `signIn`, `signOut`, `migrateRetainedLogin`, `confirmRetainedLogin`, `toolNames`, `run`, `steer`, `abort`, `approvals`, `onApproval`, `decide`, `allowOnce`, `disallowOnce`, `patchConfig`, `memoryLimited`, `doctorContext` |
| `ENGINE_VERSION`, `PROTOCOL_VERSION`, `OPERATOR_SCOPES` (`.`) | The pinned engine version, its protocol and the operator scopes the kit connects with |
| `KitOptions`, `RunSpec`, `RunEvent`, `RunEnd`, `RunUsage`, `PlanWindow`, `Route`, `Approval`, `Decision`, `ToolSpec`, `ToolHost`, `KitState`, ... (`.`) | Public types (docs/runtime-kits.md §5.2) |
| `openclawDevice(link)` (`./device`) | Portable client: state, routes, sign-in, runs, steer, abort, approvals, events, sealed notices, pass-through `call` |
| `LinkRefused`, `openNotice` (`./device`) | The host's own refusal as an error; opens a sealed approval notice |
| `words`, `stateWords`, `toAccountView` (`.`, `./device`) | The kit's sentences, so a phone shows the words the computer does; `toAccountView` feeds `@byokit/ui-core`'s `phaseOf` |
| `openclawLink(kit, o)` (`./link`) | `handle` / `stream` / `allow` for a `@byokit/link` `Host`, checked per member, plus `onAction` for relay push actions |
| `serve(o)` (`./link`) | Binds the link host per reach and returns its URLs |
| `fakeGateway`, `openclawContract`, `startModelStub`, `useModelStub` (`./testing`) | In-memory Gateway, the contract suite and the scripted model for tests |

## Phones and browsers

The host side serves member-checked ops over `@byokit/link`; the phone or browser uses the portable client:

```ts
import { Host, keyPair, type DeviceLink } from '@byokit/link';
import { OpenClawKit } from '@byokit/openclaw';
import { openclawLink, serve } from '@byokit/openclaw/link';
import { openclawDevice } from '@byokit/openclaw/device';

// On the computer (Node): member-checked ops over @byokit/link, served per reach.
declare const kit: OpenClawKit;
declare const ask: (question: string) => Promise<boolean>; // your own prompt
const api = openclawLink(kit, { memberOf: (grant) => (grant.meta as { member?: string } | undefined)?.member });
const host = await Host.open({
  keys: keyPair(),
  name: 'My computer',
  confirm: ({ name, words }) => ask(`Pair ${name}? Check it shows “${words}”.`),
  ...api,
});
const served = await serve({ host, port: 8787, via: 'lan' });
console.log(served.urls);

// On the phone or in the browser: the portable client over a paired DeviceLink.
declare const link: DeviceLink;
const oc = openclawDevice(link);
for await (const e of oc.run('Say hello.')) console.log(e);
```

## Isolation and billing

The kit writes only under the `stateDir` the app passes. It spawns the engine with an explicit isolated environment
(never `process.env`), reads no environment variables except `PATH` to find `npm`, and never bills an API behind the
person's back (memory search is never a paid provider).

## Credential sealing and threat model

The pinned engine has no supported hook for sealing OAuth profile writes. Its `auth-profiles` loader stores
credential JSON in agent SQLite databases and a shared state database, and doctor imports leave migration
archives. `authSeal` therefore protects the complete isolated `state` and `home` directories, including SQLite
journals. It uses the injected `SealingAdapter` from `@byokit/secrets`. `osKeyringSeal()` automatically
uses a persistent private file key for new stores when no non-interactive keyring is available.
Opening follows the saved envelope's mode. A locked or unresponsive keyring-only store leaves
`kit.state.phase === 'locked'`: `prepare()` and `start()` resolve, show `stateWords(kit.state)` for
recovery, and keep the sealed snapshot unchanged without launching the engine. Call `start()` again
after unlock to restore the same credentials, even if a fallback key directory now exists.

For hosts whose keyring stays locked, opt into `osKeyringSeal({ service, dualWrap: true })`.
While unlocked, reading an existing keyring-only snapshot atomically upgrades it to dual-wrap.
Later starts and stops can use the host wrap without prompting. Default off: **protection is only
as strong as the owner-only host-key file**, which must stay outside sealed-store backups.

```ts
import { osKeyringSeal, hostKeySeal } from '@byokit/secrets';
import { OpenClawKit } from '@byokit/openclaw';

const kit = new OpenClawKit({
  stateDir: './openclaw-state',
  authSeal: osKeyringSeal({ service: 'my-app-runtime' }),
});
await kit.prepare(); // seals an existing plaintext store and migration archives without starting the engine
await kit.start();   // authenticates and restores the isolated files for the engine
await kit.stop();    // waits for exit, verifies an atomic sealed snapshot, then removes plaintext

// Inspect the adapter's write mode: 'keyring', 'host-key-file' or opt-in 'dual-wrap'.
// Hosts can also explicitly supply a 32-byte key kept outside stateDir and its backups:
declare const hostKey: Uint8Array;
const server = new OpenClawKit({
  stateDir: './server-state',
  authSeal: hostKeySeal({ key: hostKey, service: 'my-app-runtime' }),
});
```

The automatic key lives in the platform state directory, separate from the engine store. A key
on the same disk protects copied stores/backups only when the key directory is excluded; it does
not protect against code running as the same OS user. See [secrets' rotation and threat model](../secrets/README.md#servers-and-headless-node).
Stop the kit, acquire the host writer lock and call `seal.rotate()` with `auth-store.sealed` plus
every retained sealed migration archive before retiring an automatic key. Rotate each envelope mode
separately; dual-wrap rotation retains old wrapping keys for backups.

Without `authSeal`, engine credentials remain plaintext. With it, successful `prepare()` and `stop()` leave
only a sealed snapshot, `auth-store.sealed`, for those directories. The adapter authenticates the snapshot
before any restoration; a wrong key, tampering, or a missing adapter rejects. Files restored for the engine
have mode 0600 and directories 0700. File symlinks are sealed only when their fully resolved targets are
regular files inside the isolated engine root; they restore as regular files at the link paths. Outside-root,
dangling and directory symlinks (including loops), sockets, FIFOs and devices are skipped.
One kit owns the store at a time; a live owner or orphan gateway blocks preparation instead of racing its writes.
Sealing copies the whole store through memory, so startup and stop cost grows with session history.

The migration doctor temporarily opens the same store and reseals it even when import fails. Once the gateway
verifies every provider, `confirmRetainedLogin()` removes the explicitly passed legacy source and writes only
an empty completion marker. It no longer creates a plaintext `.moved-to-engine` copy. On prepare, old engine
`*.json.migrated-*` and `*.json.sqlite-import.*.bak` archives and retained copies under `stateDir` are sealed
with the adapter (a `credential archive sealed` log event). Without an adapter, engine archives and confirmed
retained copies are removed (`verified credential archive removed`). An unconfirmed retained copy remains a
migration source until verified or sealed; pass its original path to migration to recover a sealed copy.
Archives stay sealed and are never restored as engine input. External source paths are handled only when the
host explicitly passes them to migration/confirmation. An app supplying a record still removes its own copy.

Residual risk: credentials are plaintext on disk and in process memory while the gateway or migration doctor
runs. Abrupt host termination or power loss cannot run stop cleanup: next prepare seals leftover live files,
but refuses while the old gateway is alive. Interrupted restore/removal is recovered from the authenticated
snapshot. A sealing failure rejects stop and retains recoverable live files; the host must resolve it and retry.
Await `stop()` during orderly shutdown. File removal does not erase old filesystem blocks, snapshots, swap or
backups; use an encrypted volume and exclude live state from backups. A same-user process, administrator,
compromised engine/plugin, memory dump, or stolen host key can read credentials. There is no rollback protection
against replacement with an older authentic snapshot. Gateway/device keys, inline config secrets, logs, engine
install/cache files and app workspaces are outside this adapter's sealing scope; protect them separately.
`doctorContext()` is an advanced escape hatch: launching an external doctor bypasses this lifecycle; use the
kit's migration method for sealed stores.

See [SECURITY.md](SECURITY.md) for the credential and approval threat model, private-directory requirements,
retained-login cleanup and sealed approval limits.

## Status

Pinned to OpenClaw `2026.8.1` (protocol 4); `ENGINE_VERSION` and `PROTOCOL_VERSION` carry the pin. Signatures are
frozen (docs/runtime-kits.md §5).

## Links

- [byokit](../../README.md), the repo root
- [docs/runtime-kits.md](../../docs/runtime-kits.md), the binding spec for this kit (§5)
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).
