<h1 align="center">@byokit/relay</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/relay"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/relay?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node | device side anywhere" src="https://img.shields.io/badge/platform-Node%20%7C%20device%20side%20anywhere-666?style=flat" />
</p>

<p align="center"><strong>A blind relay for <a href="../link"><code>@byokit/link</code></a>: the home computer dials out, phones reach it through the relay.</strong><br/>
The home computer (the <b>host</b>) needs no open port. The relay routes link's encrypted frames by host address and cannot
read them. It also keeps what a sleeping phone needs (push notifications), a short code a person can type to find a host,
and the owner's list of which hosts may use it. For apps that pair a phone or browser with a computer over link and want
to reach it away from home.</p>

The one exception to "cannot read": push notification text. The relay can read the title and any content the host
explicitly includes.

Node only (the device side, `@byokit/relay/device`, runs anywhere: no Node APIs, so browsers and React Native too).
Depends on `@byokit/link` (see [package.json](package.json) for the version) and doesn't change its wire format or crypto.

## Install

```sh
npm install @byokit/relay @byokit/link
```

[![npm](https://img.shields.io/npm/v/@byokit/relay?style=flat&label=)](https://www.npmjs.com/package/@byokit/relay) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=relay-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

```sh
npm install @byokit/relay @byokit/link
```

A relay on loopback with its state in memory, a link host registering through `RelayClient`, and a device that finds the
host by short code and pairs with it:

```ts
import { createServer } from 'node:http';
import { Host, keyPair, pairWithCode, DeviceLink } from '@byokit/link';
import { Relay, RelayClient, type RelayState } from '@byokit/relay';
import { findHost } from '@byokit/relay/device';

// The relay: loopback, state kept in memory.
let saved: RelayState | undefined;
const relay = await Relay.open({ store: { load: () => saved, save: (s) => { saved = s; } } });
const server = createServer();
relay.attach(server);
await new Promise<void>((r) => server.listen(7300, '127.0.0.1', r));

// The host: a link Host that dials out to the relay.
const host = await Host.open({
  keys: keyPair(), name: 'Kitchen computer',
  confirm: () => true, handle: (req) => ({ pong: req.op }),
});
await relay.admit(host.keys.publicKey, 'Kitchen computer');
const client = new RelayClient(host, { url: 'ws://127.0.0.1:7300/relay/v1/host', onStatus: (s) => console.log('host:', s) });
const { code: short } = await client.code();
const { code } = host.code({ role: 'control' });
console.log('short code:', short, ' link code:', code);

// The device: types both codes.
const url = await findHost('http://127.0.0.1:7300', short);
console.log('findHost:', url);
const grant = await pairWithCode(url, code, { name: 'Pixel 9', onWords: (w) => console.log('verify words:', w) });
const link = new DeviceLink(grant);
console.log('reply:', await link.request('ping'));

link.stop(); client.stop(); host.close(); relay.close(); server.closeAllConnections(); server.close();
```

Real output (codes, host id and words differ on each run):

```text
host: online
short code: RMWWK7  link code: 8Y75-TSWX-9BH9
findHost: ws://127.0.0.1:7300/link/v1/GG0AKCQjt_SpiZKdG129tg
verify words: galaxy creek
reply: { pong: 'ping' }
```

## API at a glance

| Export | What it does |
|---|---|
| `Relay` | The relay server: `Relay.open(options)`, `attach(server)` (or `upgrade` / `request`), `admit`, `enrolment`, `hosts`, `revoke`, `count`, `close` |
| `RelayClient` | The host's side: one outbound socket that proves the host's key and reconnects; `code`, `subscribe`, `unsubscribe`, `notify`, `revoke`, `stop` |
| `findHost` | The device's side: a short code → the link address to dial (also from `@byokit/relay/device`) |
| `LIMITS` | Per-client-address limits per minute |
| `CLOSE` | WebSocket close codes the relay uses (replaced, not enrolled, bad proof, enrolment, revoked, too many) |
| `isAllowedEndpoint`, `isExpoToken` | Checks for Web Push endpoints and Expo push tokens |
| Types | `RelayOptions`, `RelayStore`, `RelayState`, `HostRecord`, `Enrolment`, `RelayClientOptions`, `RelayStatus`, `PushAction`, `Notification`, `PushRecord`, `Subscription`, `WebSubscription` |

## Relay

```ts
import { createServer } from 'node:http';
import { Relay } from '@byokit/relay';

const relay = await Relay.open({
  store: { load: () => db.relayState(), save: (s) => db.setRelayState(s) },  // a 0600 file or a database row
  ownerToken: process.env.RELAY_OWNER_TOKEN,                                // turns on the owner's HTTP routes
  push: { subject: 'mailto:you@example.com' },
});
const server = createServer();
relay.attach(server);           // or call relay.upgrade(req, socket, head) and relay.request(req, res) from your own routes
server.listen(7300, '127.0.0.1');   // put TLS in front (Tailscale Serve, Caddy, …); set trustProxy if it adds X-Forwarded-For
```

Routes:

| Route | Who | What |
|---|---|---|
| `WS /link/v1/<host id>` | a device | bare link frames to and from that host |
| `WS /relay/v1/host` | a host | proves its key, then carries its devices' frames as `{c, f}` / `{c, end}` |
| `GET /relay/v1/codes/<code>` | a device | a short code → `{ host }` |
| `POST /relay/v1/push/action` | a device | `{ token, action }`: a notification's button, answered by the host |
| `POST /relay/v1/enrolments`, `GET /relay/v1/hosts`, `DELETE /relay/v1/hosts/<id>` | the owner (`Authorization: Bearer <ownerToken>`) | make an enrolment, list and revoke hosts |

## Which hosts may register

A host's address is link's `host.id`, a hash of its public key. To register, a host proves it holds that key: the relay
sends a fresh X25519 key and a nonce, and the host answers with an HMAC keyed by their DH. A proof is good for that one
socket, so it can't be replayed, and nobody can register under another host's address. The relay never trusts where a
connection comes from: behind a tunnel everything looks like loopback.

A host must also be allowed:

- **Self-hosted, beside one host:** `await relay.admit(host.keys.publicKey, 'Kitchen computer')`.
- **A shared relay on a VPS:** the owner makes a one-use enrolment that lasts five minutes
  (`relay.enrolment({ name })`, or `POST /relay/v1/enrolments`), and gives the token to the machine. The machine
  registers with it once; after that its key is enough. Only a hash of the claim is kept.

`relay.revoke(id)` removes a host: its registration, push subscriptions and codes go, and its socket and its devices'
sockets close. A second copy of the same host (same key) replaces the first, which is closed with `4000 replaced by a
newer host` and stops rather than fight back.

## Host

```ts
import { RelayClient } from '@byokit/relay';

const relay = new RelayClient(host, {         // host: a link Host
  url: 'wss://relay.example/relay/v1/host',
  enrol: token,                                // first time only, on a shared relay
  onStatus: (s) => log(s),                     // connecting, online, offline (it retries), replaced, refused
  onAction: ({ device, event, action }) => app.answer(event, action),
});
host.offer({ role: 'control', urls: [`wss://relay.example/link/v1/${host.id}`] });
```

It reconnects with backoff (1 s to 30 s). Its requests to the relay (`code`, `subscribe`, `unsubscribe`, `notify`) wait
in a queue of 64 while the socket is down, and whatever the relay had not answered is sent again on the next socket.

## Typed pairing through a relay

Link's typed code needs the host's address, which nobody types. The host asks the relay for a short code (six
characters, five minutes) that points at it, and shows it with link's code:

```ts
const { code: short } = await relay.code();   // e.g. K7M2QX, for the relay
const { code } = host.code({ role: 'control' });  // e.g. 7KQ4-M2XP-9RTH, for link
```

```ts
import { findHost } from '@byokit/relay/device';
import { pairWithCode } from '@byokit/link';
const url = await findHost('https://relay.example', short);   // wss://relay.example/link/v1/<host id>
const grant = await pairWithCode(url, code, { name: 'Pixel 9', onWords: (words) => console.log('Verify on host:', words) });
```

The relay only ever learns which host a short code points to, never link's code.

## Push notifications

A device sends its push address to the host over the link; the host stores it on the relay for that device (its grant
id), and notifies:

```ts
await relay.subscribe(device.id, { expo: 'ExponentPushToken[…]' });            // or { web: pushSubscription.toJSON() }
await relay.notify({ id: 'evt-42', title: 'Agent update', to: [device.id], actions: ['yes', 'no'] });
await relay.revoke(device.id);   // link's revoke, then remove relay subscriptions
```

A browser subscribes with the relay's Web Push key (`relay.vapidKey`, sent to it over the link). A notification with the
same `id` is deduplicated while the relay runs; a restart can deliver a retried notification twice. Expo tokens a device
dropped (`DeviceNotRegistered`) and Web Push subscriptions that are gone (404, 410) are removed.

Web Push endpoints must use HTTPS on `fcm.googleapis.com`, a subdomain of `push.apple.com`,
`updates.push.services.mozilla.com`, or a subdomain of `notify.windows.com`. `push.hosts` in `Relay.open` can narrow
these destinations (including to an exact subdomain), never expand them. Redirects are not followed, and disallowed
subscriptions restored from storage are removed before delivery.

`RelayClient.notify` sends the title but omits `body` and `data` by default, even if supplied. Pass
`{ includeContent: true }` as its second argument to forward them. Choose a generic title too; see
[SECURITY.md](SECURITY.md) for the push-content boundary and offline device-revoke limit.

With `actions`, each device's notification carries its own one-use `action` token. Pressing a button posts
`{ token, action }` to `/relay/v1/push/action`; the relay asks the host (`onAction`) and waits up to 15 seconds for the
answer, which goes back to the device.

## Limits

Per client address, per minute, as in muxr's relay: 60 WebSocket connections, 10 short-code lookups,
20 button presses, 10 enrolment claims and 10 failed host proofs. At most 256 live devices per host.

## Links

- [byokit](../../README.md): the other packages
- [`@byokit/link`](../link): pairing and the encrypted link this relay carries
- [SECURITY.md](SECURITY.md): what the relay can and cannot see
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).
