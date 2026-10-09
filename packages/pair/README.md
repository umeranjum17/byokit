<h1 align="center">@byokit/link</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/link"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/link?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node | browsers | React Native" src="https://img.shields.io/badge/platform-Node%20%7C%20browsers%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>Scan a code to pair a phone or browser with the home computer.</strong><br/>
One encrypted link between the two. The computer (the <strong>host</strong>) keeps every credential; a device holds
only its own key and a grant, and asks the host to do things. For apps that reach a person's own computer from their
phone or browser.</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/herdr-kit-host.png" width="420" alt="A terminal running npm start -- --herdr &quot;$(command -v herdr)&quot; --via lan --name 'Kitchen computer', showing a large pairing QR code, then: On the phone, scan this. If its page is already open there, type K3J8-CJZ7-SE4R instead. Codes last five minutes. Press Enter for new ones. Connecting to Herdr… Connected to Herdr. (stand-in Herdr)" />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/examples/herdr-kit/docs/2-compare.png" width="240" alt="A phone page titled Agents, under Pair this phone: Check your computer shows these two words, then say yes there. The words are coast comet." />
</p>
<p align="center"><sub>Left: the host terminal of <a href="https://github.com/umeranjum17/byokit/tree/main/examples/herdr-kit">examples/herdr-kit</a> (<code>npm start -- --herdr "$(command -v herdr)" --via lan --name 'Kitchen computer'</code>, pictured against the kit's stand-in Herdr, <code>BYOKIT_EXAMPLE_FAKE=1</code>) showing the QR and the typed code. Right: the phone in the same example showing the two words to compare.</sub></p>

Noise IK over WebSocket (`noise-handshake` + libsodium; frames sealed by `@noble/ciphers`), in Node, browsers/PWAs
and React Native. The main entry has no listener, files or environment access: the app hands the host its sockets
and stores. Threat model and review checklist: [SECURITY.md](SECURITY.md).

Host policy and streams are available; relay routing is in [`@byokit/relay`](../relay).

## Install

```sh
npm install @byokit/link
```

[![npm](https://img.shields.io/npm/v/@byokit/link?style=flat&label=)](https://www.npmjs.com/package/@byokit/link) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=link-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

```sh
npm install @byokit/link ws
```

`ws` is only the WebSocket server for this example; any server works. A host and a device in one file, on loopback:

```ts
import { WebSocketServer } from 'ws';
import { DeviceLink, Host, keyPair, pairWithOffer } from '@byokit/link';

// The computer: it keeps the credentials and answers requests.
const host = await Host.open({
  keys: keyPair(),                       // keep it with hostKeyFile() from '@byokit/link/node' in a real app
  name: 'Kitchen computer',
  confirm: ({ name, words }) => { console.log(`host: pair ${name}? it shows "${words}"`); return true; },
  handle: (req, device) => ({ echo: req.args, from: device.name }),
});
const wss = new WebSocketServer({ host: '127.0.0.1', port: 7300 });
wss.on('connection', (ws) => host.accept(ws));

// The offer is what the QR code shows.
const { text } = host.compactOffer({ role: 'control', urls: ['ws://127.0.0.1:7300/link'] });

// The phone or browser: scan, compare the words, then ask.
const grant = await pairWithOffer(text, { name: 'Pixel 9', onWords: (w) => console.log(`device: check "${w}"`) });
const link = new DeviceLink(grant, { onStatus: (s) => console.log(`device: ${s}`) });
console.log('answer:', await link.request('say.hello', { text: 'hi' }));

link.stop(); host.close(); wss.close();
```

Output (the two words differ on every run):

```text
device: check "rose oak"
host: pair Pixel 9? it shows "rose oak"
device: online
answer: { echo: { text: 'hi' }, from: 'Pixel 9' }
```

## API at a glance

| Export | What it does |
|---|---|
| `Host` | The computer's end: `Host.open(options)`, then `accept`/`relay` sockets, `offer`/`compactOffer`/`code`/`shortCode`/`enrol` to pair, `devices`, `setMeta`, `revoke`, `broadcast`, `close` |
| `pairWithOffer`, `pairWithCode` | Pair a device from a scanned offer or a typed code; returns its `DeviceGrant` |
| `parseOffer`, `offerText`, `cleanName` | Read a QR or link, build terminal-to-browser links, and clean a displayed name |
| `encodeOffer`, `decodeOffer` | Complete offline offer in typeable groups, with a transcription checksum |
| `pendingGrant` | A grant saved before pairing, for crash-safe pairing |
| `check` | Probe URLs for a link host before pairing, without touching the offer |
| `DeviceLink` | A device's live link: `request`, `stream`, `addUrl`, `rekey`, `unpair`, `retry`, `stop` |
| `LinkStream`, `WINDOW` | A duplex byte stream and its per-direction window (256 KB) |
| `LinkError`, `PublicLinkError`, `LINK_WORDS` | Failures with a plain `message` and a `code`; a handler error safe to show; the plain message for each failure code |
| `secureDeviceStore`, `browserDeviceStore` | Where a device keeps its grant on a phone or in a browser |
| `keyPair`, `keyPairFrom`, `hostId`, `b64url`, `unb64url`, `normalizeCode` | Keys, the host id, base64url and typed-code helpers |
| `hostKeyFile`, `fileDeviceStore` (`@byokit/link/node`) | Node only: the host's key file, and a computer's device store |

## Host

```ts
import { Host } from '@byokit/link';
import { hostKeyFile } from '@byokit/link/node';

const host = await Host.open({
  keys: hostKeyFile('./link-secret/host.key'), // made once in its own 0700 folder; or use your keychain
  name: 'Kitchen computer',
  grants: { load: () => db.grants(), save: (g) => db.setGrants(g) },
  confirm: ({ name, words, role }) => ui.ask(`Pair ${name}? Check it shows “${words}”.`),
  canView: (req) => req.op.startsWith('get.'),     // what view-only devices may ask; default nothing
  handle: (req, device) => app.run(req.op, req.args, device),
});
wss.on('connection', (ws) => host.accept(ws));   // any WebSocket server; bind it to loopback/tailnet by default

const { text } = host.compactOffer({ role: 'control', urls: ['ws://192.168.1.20:7300/link'] });  // show as a QR
const { code } = host.code({ role: 'view' });     // or a code to type: "7KQ4-M2XP-9RTH"
host.devices(); await host.revoke(id); host.broadcast(event);
```

`hostKeyFile(path)` from `@byokit/link/node` wants a path in its own private (`0700`) folder; it refuses an
existing folder with another mode rather than changing its permissions.

More host policy, all optional:

- `offer`/`code`/`enrol` take `kind` (e.g. `'browser'`, `'peer'`), `lifetime` (ms; access then ends like a removal)
  and `meta`. The offer carries `role` and `lifetime`, so the device can show what it is agreeing to.
- `allow: (req, device) => boolean` decides when asked (e.g. from capabilities kept in `meta`); without it,
  control devices may do anything and view-only ones what `canView` allows. Do not mutate a grant's `meta` in place:
  use `await host.setMeta(id, newMeta)` or revoke it to withdraw access. Work already started is not rolled back.
- `caps: { peer: 16 }` limits devices per kind; `maxDevices` limits them all.
- `answers: { get, put, drop }` keeps completed answers across host restarts. `req.key` is stable per device and retry;
  handlers with transactional effects can store it alongside the effect to avoid repeating work after a crash between
  the handler and `answers.put`.
- `handshakes: { perMinute, perPeer }` limits new handshakes; pass `host.accept(ws, { peer: ip })` to count per source.

`compactOffer` is the QR text: the same secret a typed code carries (same single use, life, words and
approval) plus the addresses to try, packed binary, so a standard offer fits a QR version 4 or lower.
`pairWithOffer` scans both compact and version 1 offers; version 1 keeps parsing for one release.
`offer({ base: 'https://app.example/pair' })` makes a link a browser can open instead of a bare QR text.
Handler errors are logged on the host (`onError` can receive them). Devices see “Your computer couldn't do that.”
unless the handler explicitly throws `new PublicLinkError('A message safe to show.')`.

## Browser pairing

Apps should offer browser pairing as **view-only by default**: `role: 'view'`, `kind: 'browser'`, a short
`lifetime`, and a narrow `canView` policy. `control` is offered only when the app explicitly opts in.
[SECURITY limit 7](SECURITY.md#known-limits) applies: IndexedDB sealing protects stored records, but a live
XSS on the app's origin can still use an unlocked key. View-only limits that access; keep untrusted scripts off
that origin. An `allow` policy, when supplied, must enforce the chosen role itself.

```ts
const { text } = host.offer({
  role: 'view', kind: 'browser', lifetime: 15 * 60_000,
  urls: ['wss://relay.example/link/v1/' + host.id],
  base: 'https://app.example/pair.html',
});
console.log(text); // terminal-to-browser deep link; the offer stays after #
```

`offerText(parseOffer(text), 'https://app.example/pair.html')` makes the same deep link from an existing offer.
There is no separate `offerLink`. Use `parseOffer(text, 0)` to inspect an expired offer; this does not renew it,
and pairing still refuses an expired ticket. `parseOffer` reads a compact QR too, returning a `CompactOffer` (expiry,
addresses, name, role) with no `host` or `ticket`: narrow with `'host' in offer` before reading a version 1 offer's
fields, and before `offerText` or `encodeOffer`, which take a version 1 `PairOffer`.

For an offline, typeable alternative, `encodeOffer(parseOffer(text))` holds the **entire offer**, including
all direct and relay addresses. `decodeOffer` also reads old compact direct codes for migration, preserving
their key, ticket, role and second-resolution expiry; re-encoding uses the current complete format.
`decodeOffer(typed)` returns a `PairOffer` and checks expiry without contacting
any service; pass `offerText(decoded)` to `pairWithOffer`. Groups of five characters may be separated by spaces
or dashes; case is ignored, O means 0 and I/L mean 1. Other mistakes fail the checksum. The checksum catches
transcription errors, not tampering: Noise authenticates the host and the person still approves the two words.
This envelope is longer than the 12-character `host.code()` PSK code, which uses `pairWithCode` and a known
host address. Both obey the same single-use, at-most-five-minute pairing window.

The [PWA pairing page](../../examples/pwa/pair.html) accepts a deep link or pasted envelope, compares words,
keeps the grant in `browserDeviceStore`, and requests `get.summary`. Run `npm run build`, then
`node examples/pwa/serve.ts 8080` and open `http://127.0.0.1:8080/pair.html`. The host must expose a reachable
WebSocket, permit `get.summary` with `canView`, and handle that request. Use HTTPS and `wss:` when deploying.

### Presence, durable grant changes and app metadata

`onConnection(grant, online)` on `Host.open` reports the first authenticated socket up and the last down for
that grant, including direct/relayed disconnects, revoke, expiry and host close. Duplicate sockets do not flap
presence. A failed removal keeps presence unchanged. Pairing itself briefly opens a socket; it counts too.
Callback exceptions reach `onError` and do not interrupt cleanup.

`await host.reload()` re-reads `grants.load()` in the same queue as grant changes. It never writes the loaded
snapshot back. Missing grants close their live sockets and discard cached answers; changed keys/roles close
old connections, and changed expiry reschedules access. A failed load rejects and leaves memory intact.
A `GrantStore` may provide `subscribe(changed): unsubscribe`; the host reloads automatically on notification,
reports reload failures through `onError`, and unsubscribes on `close()`.

Node apps can use `fileGrantStore(path)` from `@byokit/link/node`. It touches the app's chosen file, temporary
files and a sibling `.lock` only, writes atomically at 0600 in a 0700 folder, rejects symlinks/nonprivate files on read, and polls
for cross-process replace/remove (default 100 ms; second argument changes the interval). Cooperating writers
use an exclusive lock and reject a stale loaded snapshot instead of overwriting an external revoke. Load again
before retrying a failed save. A process that crashes holding the lock requires the app to resolve that abandoned
lock; the kit never breaks it. Other file writers must use this backend too to get the write-conflict protection.
Notifications are eventual, not a transaction across running hosts: apps needing instantaneous admission against
an external authority must also check it in `allow`.

`deviceMeta: (grant) => ({ appVersion, scope: (grant.meta as AppMeta)?.scope })` opts in to app metadata in the sealed `ready`
payload. Project only data the device may see: the host never copies grant metadata implicitly. `DeviceGrant.meta`
contains it after either pairing flow, and `DeviceLink.grant.meta` refreshes on reconnect (and clears if a newer
ready omits it). It travels inside Noise, including through a relay.

### Short-lived peer invitations

Compose invitations with the host's existing request handler, pending offer metadata and confirmation callback.
The **handle** step authorizes the already-paired inviter, **offer** records the host-chosen invitation scope,
then **confirm** checks that metadata before approving the new peer:

```ts
import { Host, keyPair, PublicLinkError } from '@byokit/link';

// Supply the app's human approval UI.
declare const ui: { ask(message: string): Promise<boolean> };
const urls = ['wss://relay.example/link/v1/your-host-id'];
const host: Host = await Host.open({
  keys: keyPair(), name: 'Kitchen computer',
  canView: (req) => req.op === 'get.summary',
  handle: (req, inviter) => {
    if (req.op === 'peer.invite' && inviter.role === 'control') {
      return host.offer({ role: 'view', kind: 'peer', urls,
        meta: { invitedBy: inviter.id, scope: 'summary' } });
    }
    if (req.op === 'get.summary') return { text: 'Ready to read.' };
    throw new PublicLinkError('That action is unavailable.');
  },
  confirm: async ({ kind, meta, name, words }) => {
    const invitation = meta as { invitedBy?: string; scope?: string } | undefined;
    if (kind !== 'peer' || invitation?.scope !== 'summary' ||
        !host.devices().some((g) => g.id === invitation.invitedBy && g.role === 'control' &&
          (g.expires === undefined || g.expires > Date.now()))) return false;
    const approved = await ui.ask(`Pair ${name} to read the summary? Check “${words}”.`);
    return approved && host.devices().some((g) => g.id === invitation.invitedBy &&
      g.role === 'control' && (g.expires === undefined || g.expires > Date.now()));
  },
});
```

Import `Host`, `keyPair` and `PublicLinkError` from `@byokit/link`; `ui.ask` is the app's approval UI. The app
chooses metadata on the host, never from an untrusted invitee. This composition is delegated pairing:
the approved control device requests a constrained invitation; a peer cannot widen its terms. Check the
inviter's current grant, including expiry, in both `handle` and `confirm`. Apply capability scope in `allow`
for every peer request or stream; `meta` alone does not enforce it. Revoking the inviter cancels redemption
when `confirm` checks it; already-paired peers are independent grants unless the app revokes them too. No grant exists until `confirm` says yes. This is
an online invitation: single-use and at most five minutes, with the host present for pairing. It is not a
long-lived or host-offline signed invitation.

## Device

To keep several paired computers, use `secureDeviceStores(secureStore, prefix?)` or
`browserDeviceStores(databaseName?)` from `@byokit/link`. Both offer `list()` (entry names), `load(name)`,
`save(name, grant)`, `remove(name)`, and `store(name)` (the one-entry adapter for `DeviceLink`). Names use
letters, digits, dots, underscores and dashes, up to 120 characters. A secure collection uses
`<prefix>.index` and `<prefix>.grant.<name>`; existing single-entry stores stay independent. Calls sharing
one secure module/prefix are serialized within the JS runtime; the native API supplies no cross-process
transactions. Missing records from interrupted saves are omitted from the index listing.
The browser collection enumerates existing `browserDeviceStore` entries in its database, preserving their
non-extractable wrapping keys and forgotten-grant protection; removed tombstones stay out of `list()`.

```ts
import { DeviceLink, secureDeviceStores, type DeviceGrant, type SecureStoreLike } from '@byokit/link';

// Supply the platform secure-storage module and a grant returned by pairing.
declare const SecureStore: SecureStoreLike;
declare const grant: DeviceGrant;
const computers = secureDeviceStores(SecureStore);
await computers.save('kitchen', grant);
const link = new DeviceLink((await computers.load('kitchen'))!, { store: computers.store('kitchen') });
const pairedNames = await computers.list();
// Local forgetting only; link.unpair() first when the host should remove its grant too.
await computers.remove('kitchen');
```

```ts
import { DeviceLink, pairWithOffer, pairWithCode } from '@byokit/link';

const grant = await pairWithOffer(scanned, { name: 'Pixel 9', onWords: (w) => show(w) });
// Or pairWithCode(url, typed, { name: 'Pixel 9', onWords: (w) => show(w) });
await secureStore.save(grant);                    // it holds this device's secret key
const link = new DeviceLink(grant, { store: secureStore, onStatus, onEvent });
await link.request('send.message', { text: 'hi' });  // waits through reconnects
await link.request('send.message', { text: 'hi' }, { timeoutMs: 20_000, notValidAfter: Date.now() + 60_000 });
```

- For crash-safe pairing, pass `onPending: (g) => secureStore.save(g)` to `pairWithOffer`. It gets the pending grant
  before the host can approve this device: for a compact offer, once the host proved it holds the code and before
  this device's key and name reach it (so the grant pins the host key the handshake authenticated); for a version 1
  offer, before dialling. If the app dies while the person decides, a `DeviceLink` made from the saved pending grant
  retries until approval (up to five minutes after the offer expires), then forgets it if the host still has not
  approved; a host with another key there is `refused`. Because the device tells the host it kept a pending grant, a yes
  given after it went away still counts; a device that kept none gets no grant it could never use. So when
  `pairWithOffer` rejects after `onPending` ran without a sealed refusal (`e.sealed` false, e.g. `unreachable` once the
  words were shown), keep the pending grant and make a `DeviceLink` from it: it comes online on a yes and forgets
  itself on a no.
  `pendingGrant(scanned, { name, key, host })` builds the same grant; a compact offer needs `host`.
- `resolve: (url) => …` runs before each dial (e.g. open an SSH tunnel and return `ws://127.0.0.1:<port>/…`);
  `link.addUrl(url)` adds an address found later (a wrong host there just fails its handshake).
- A quiet connection is pinged (`pingMs`, default 20 s) and redialled when the host stops answering; at most
  `maxPending` requests (default 1000) wait at once.
- `link.rekey()` moves the device to a fresh key without a moment where no key works; `link.unpair()` asks the
  computer to remove the grant and forgets it locally only after confirmation. Offline or failed removal keeps the grant.

Statuses:

- `connecting`, `online`.
- `offline`: it keeps retrying.
- `refused`: every address answered with another host key; the grant is kept, `retry()` or pair again.
- `removed`: the host removed this device; the grant is forgotten.

Every failure is a `LinkError` with a plain `message` and a `code`. `stop()` rejects unanswered and new requests until
`retry()`. Retry guarantees and their limits: [SECURITY.md](SECURITY.md#known-limits).

### Where a device keeps its grant

One store per paired computer, each with `load()` for the next start:

| Where | Store | Notes |
|---|---|---|
| Phone | `secureDeviceStore(SecureStore, 'byokit.link.home')` with `expo-secure-store` | Keychain on iOS, Keystore on Android; the grant is about 300 bytes, one value. |
| Browser or PWA | `browserDeviceStore('home')` | IndexedDB, sealed with AES-GCM by a non-extractable browser key. The stored record alone opens nothing, but scripts running on the same origin can still use the key to decrypt it; keep untrusted scripts off the page. |
| Computer (Node, Electron's main process) | `fileDeviceStore(path, safeStorage?)` from `@byokit/link/node` | A 0600 file in a newly created 0700 folder (an existing folder keeps its permissions), sealed with Electron's `safeStorage` when given. Without `safeStorage`, the file contains the grant in plaintext. |

```ts
const store = secureDeviceStore(SecureStore, 'byokit.link.home');
const grant = (await store.load()) ?? await pairWithOffer(scanned, { name: 'Pixel 9', onWords: show });
await store.save(grant);
const link = new DeviceLink(grant, { store, onStatus });
```

### React Native

Install a `crypto.getRandomValues` polyfill such as `react-native-get-random-values` (or use `expo-crypto`) and
import it **before** `@byokit/link`. Metro resolves `sodium-universal` to `sodium-javascript` through its browser
field. The device uses the platform's WebSocket and needs no Node globals. See [`examples/expo`](../../examples/expo).

## Streams

For what doesn't fit a request: a terminal pane, a tunnelled TCP connection, a call's audio. A stream is duplex and
carries bytes; each direction has a 256 KB window, so a slow reader holds the writer back instead of filling memory.

```ts
// Host: take streams devices open. `device` is the authenticated grant (one controller per pane…). The stream
// opens first; a thrown `PublicLinkError` ends it with its message, while other errors go to `onError` and end it with `failed`.
const host = await Host.open({ ...options, stream: (s, req, device) => {
  const pty = panes.attach((req.args as { pane: string }).pane, device.id);  // your code
  s.onData = (keys) => pty.write(keys);                       // return a promise to hold the device back
  s.onEnd = () => pty.detach();
  pty.onOutput((bytes) => s.write(bytes));                    // have the producer await this promise for backpressure
} });

// Device: only while online. A stream ends with its socket (`onEnd('unreachable')`); open it again on `online`.
const s = await link.stream('terminal', { pane: 'p1' });
s.onData = (bytes) => term.write(bytes);
await s.write('ls\r');
s.end();
```

View-only devices open only the streams `allow` permits (or `canView` when `allow` is absent). A host without `stream`
tells devices so (`LinkError` `not-supported`), and so does a host older than streams.

On a direct socket, stream bytes go as binary WebSocket messages (without base64 overhead); through a relay, whose
host wrapper is text, the same frames go as base64 text. The host says which in `ready`; everything else stays text.

Speed, measured with Hermes (the CLI, v0.13, on a desktop CPU; `bench/hermes.sh`, not a phone measurement): the device
path opens about 4.8 MB/s of stream bytes on a direct socket and 3.9 MB/s through a relay, where muxr's tweetnacl
opens its binary preview tunnel at about 4.6 MB/s. Frames are sealed with `@noble/ciphers`; sodium-javascript's
ChaCha20 managed about 2.5.

## Through a relay

Frames are the same bytes on every path; a relay only routes them and cannot read them.

- A device dials `wss://<relay>/link/v1/<host id>` (`host.id`, a hash of the host key) and sends and receives bare
  frames, exactly as on a direct socket. Put that address in the offer's `urls`.
- The host keeps one socket to the relay and passes it to `host.relay(ws)`. Each message on it is
  `{"c": "<connection id>", "f": "<frame>"}`, or `{"c": "…", "end": <code>}` when either side closes.
- The relay authenticates the host's socket and limits abuse its own way. Link routing needs no device id: the host
  checks devices itself on every handshake.

`@byokit/link` does not include a relay server; use [`@byokit/relay`](../relay) for the standalone server,
reconnecting host client and device code lookup.

## Migrating pre-kit phone pairings

For a pre-kit Crewhouse phone pairing, call `migrateGrant(raw, { format: 'crewhouse-v0' })`
and save the returned `DeviceGrant` in the app's device store. `raw` is a parsed object
or JSON with exactly `{ sk, crewdPk, fp, urls, device: { id, name, role } }`, with no
version field. Both keys are canonical padded base64 for 32 bytes; `fp` is the first
eight bytes of BLAKE2b-128 of `crewdPk`, in lowercase hex groups of four digits
separated by spaces. Addresses must be nonempty WebSocket URLs without credentials
or fragments, and the role is `control` or `view`. Names, IDs and addresses are preserved;
the host name becomes `your computer`. Database device rows are not this phone format.

Invalid input throws `GrantMigrationError` with `code: 'invalid-grant'`; an unknown
format throws it with `code: 'unsupported-format'`. Migration neither logs nor persists
anything. The fingerprint detects an inconsistent host key; it is not a signature.
The host still verifies the device key and supplies its current permissions on connection.

## Moving already-paired devices (muxr)

muxr's existing X25519 box keys can be used as link static keys without an exchange or re-pairing:

1. Run `Host` beside the old transport with `keys: keyPairFrom(machineBoxSecretKey)`. Enrol each existing
   `devicePublicKey` with `host.enrol({ key, name, role, meta })`: `observe` becomes `view`, `control` stays
   `control`, and `meta` keeps the muxr device id and kind. No device-to-host key exchange is needed.
2. Route link sockets through the relay's `/link/v1/<hostId>` path or an existing Tailscale/SSH route.
3. On app update, build a `DeviceGrant` using the **stored** device box secret key and machine box public key
   (base64 to base64url only), the route and a placeholder device id. `DeviceLink` authenticates with the same
   keys; `ready` fills the enrolled id, name and role. No re-pairing is needed.
4. Once a device connects over link, refuse its old transport. Turn the old transport off when all devices have
   moved; keep enrolments so offline devices can migrate whenever they return. Revoke both transports during cutover.

The same X25519 key serves nacl.box and Noise while both transports run; a later rekey can rotate it. Muxr phones
share one key across machines. Muxr parity beyond this migration is tracked separately.

## Checking reachability before pairing

```ts
import { check, parseOffer } from '@byokit/link';

// Before asking the person to approve, the phone probes the offer's URLs (the host probes its own advertised
// URLs the same way, as a self-check only). Results come back in input order.
export async function precheck(scanned: string): Promise<void> {
  const { urls } = parseOffer(scanned);
  const results = await check(urls, { timeoutMs: 5000 });
  for (const r of results) {
    if (!r.ok) console.log(`${r.url}: ${r.message}`);  // r.code is a LinkProblem: unreachable, timeout, wrong-host
  }
}
```

Probed four at a time by default (`concurrency` changes that). The probe answers read-only: it sends no ticket,
so a checked offer still pairs afterwards, and the reply carries nothing but the fact a link host is there. It
works in Node, browsers and React Native, and through a relay with no relay change (devices speak bare frames
there).

## Typed pairing on a small terminal

`host.shortCode(terms)` returns `{ code, expires }`. Feed the **whole** code to the existing
`pairWithCode(url, code, options)` on the phone or browser. This is a typed alternative to the QR,
not a smaller QR: its 57 printed characters fit on one line in an 80-column terminal. The device
must already know an address (a host-served page can use its own address).

### Security design

The code format is `K1-<12 random characters>-<32 hexadecimal characters>`, grouped in fours.
The random part uses the existing unbiased 31-symbol alphabet: `12 × log2(31) = 59.45` bits.
The hexadecimal part is a **128-bit machine-key commitment**, BLAKE2b-128 of
`byokit-link-short-key-v1` followed by the host's 32-byte X25519 public key. Case, whitespace and
dashes are ignored; the version, lengths and alphabets are validated before dialing. A malformed
commitment never falls back to the legacy 12-character code.

Pairing reuses the pinned Noise XXpsk0 implementation and libsodium hash, with the random part
as the existing PSK input. After authenticating Noise message 2, the device checks the responder's
static public key against the commitment **before sending its own static key/name in message 3**,
displaying words, or accepting a grant. Noise proves possession of the committed key's secret;
a network attacker or malicious relay cannot substitute another key even if it knows the random
part. Finding another key for this fixed commitment requires a targeted 128-bit preimage search.
The commitment is public and adds no secret entropy. No new cryptographic primitive or PAKE is
implemented. This intentionally keeps more characters than an eight-character password: XXpsk0
permits offline guessing from a captured handshake even after expiry; the 59.45-bit random part
is still the defense ([security limit 1](SECURITY.md#known-limits)). A shorter secret needs a
reviewed PAKE and is outside this API.

The host consumes the random code on its first valid presentation, including declined pairing.
Five wrong code attempts withdraw **all** open codes and QR tickets; handshake limits remain
300/minute globally and 30/minute per source when the app supplies `peer`. Codes expire after
`pairMs` (at most five minutes), checked on presentation and through grant persistence. Replay,
late approval and expiry never create a grant. Malicious routing can still deny service or consume
a code by forwarding a live attempt. Anyone who photographs the full code can race to pair with
the real host, so **both screens still show the same two words and host approval defaults to No**.
Only an explicit affirmative response after matching words should return `true` from `confirm`.
The kit has no approval UI; exceptions and confirmation timeouts decline.

For relay discovery, display the separate six-character `RelayClient.code()` lookup alongside
the full `host.shortCode()` pairing code. The device calls `findHost(relay, lookup)` from
`@byokit/relay`, then `pairWithCode(url, fullPairingCode, options)`. Send **only the lookup** to
`findHost`; never send the pairing secret to an HTTP lookup service. The lookup supplies an
untrusted address, never a trusted machine key. A malicious lookup pointing at another host
fails the commitment check. QR offers and legacy `host.code()` remain compatible; callers of
the latter do not get this additional machine-key pinning.

Runnable loopback example (Node 22.18+, `npm install @byokit/link ws`; save as `pair.ts`, run
`node pair.ts`). In an app, show the code on the computer and let the phone type it:

```ts
import { createInterface } from 'node:readline/promises';
import { WebSocketServer } from 'ws';
import { DeviceLink, Host, keyPair, pairWithCode } from '@byokit/link';

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const host = await Host.open({
  keys: keyPair(), name: 'Umer’s computer',
  confirm: async ({ name, words }) => {
    console.log(`${name} shows “${words}”. Compare both screens.`);
    return (await terminal.question('Do the words match? Approve? (y/N) ')).trim().toLowerCase() === 'y';
  },
  handle: () => ({ message: 'Hello, Umer' }),
});
const server = new WebSocketServer({ host: '127.0.0.1', port: 7300 });
await new Promise<void>((resolve) => server.once('listening', resolve));
server.on('connection', (ws) => host.accept(ws));
const { code, expires } = host.shortCode({ role: 'control' });
console.log(`Type ${code} before ${new Date(expires).toISOString()}`);
try {
  const grant = await pairWithCode('ws://127.0.0.1:7300/link', code, {
    name: 'Umer’s phone', onWords: (words) => console.log(`Phone: “${words}”`),
  });
  const device = new DeviceLink(grant);
  try { console.log(await device.request('hello')); } finally { device.stop(); }
} finally {
  terminal.close(); host.close(); server.close();
}
```

## Links

- [byokit](../../README.md): every package and example.
- [SECURITY.md](SECURITY.md): threat model, review checklist and known limits.
- [CHANGELOG.md](CHANGELOG.md).
- [`@byokit/relay`](../relay): relay server, host client and code lookup.
- Examples: [`examples/herdr-kit`](../../examples/herdr-kit) (pairing a phone browser with Herdr on the computer) and
  [`examples/expo`](../../examples/expo) (React Native, iOS and Android).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](https://github.com/umeranjum17/byokit/blob/main/NOTICE).
