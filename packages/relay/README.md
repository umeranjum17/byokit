# @byokit/relay

A relay for [`@byokit/link`](../link): the home computer (the **host**) dials out to it, so it needs no open port, and
phones and browsers reach the host through it. The relay routes link's encrypted frames by host address and cannot read
them. It also keeps what a sleeping phone needs (push notifications), a short code a person can type to find a host,
and the owner's list of which hosts may use it.

Node only (the device side, `@byokit/relay/device`, runs anywhere). Stacks on `@byokit/link` 0.1 and doesn't change its
wire format or crypto.

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
const url = await findHost('https://relay.example', short);   // wss://relay.example/link/v1/<host id>
const grant = await pairWithCode(url, code, { name: 'Pixel 9' });
```

The relay only ever learns which host a short code points to, never link's code.

## Push notifications

A device sends its push address to the host over the link; the host stores it on the relay for that device (its grant
id), and notifies:

```ts
await relay.subscribe(device.id, { expo: 'ExponentPushToken[…]' });            // or { web: pushSubscription.toJSON() }
await relay.notify({ id: 'evt-42', title: 'Agent update', body: 'An agent needs you', to: [device.id], actions: ['yes', 'no'] });
await relay.revoke(device.id);   // link's revoke, and the device's subscriptions go too
```

A browser subscribes with the relay's Web Push key (`relay.vapidKey`, sent to it over the link). A notification with the
same `id` is sent once. Expo tokens a device dropped (`DeviceNotRegistered`) and Web Push subscriptions that are gone
(404, 410) are removed. Subscription endpoints must be public https push services, never internal addresses.

With `actions`, each device's notification carries its own one-use `action` token. Pressing a button posts
`{ token, action }` to `/relay/v1/push/action`; the relay asks the host (`onAction`) and waits up to 15 seconds for the
answer, which goes back to the device.

## What the relay sees

- Link frames: ciphertext only. It never learns a device's name, id or requests, or a pairing code.
- Which host each device socket is for, when, and from which address.
- Push notifications: their text, data and buttons, as the host wrote them. Expo (and Google or Apple behind it) sees
  them too; Web Push is encrypted to the browser. Keep them generic, and let the device fetch details over the link.

## Limits

Per client address, per minute, as in muxr's relay: 60 WebSocket connections, 300 HTTP requests, 10 short-code lookups,
20 button presses, 10 enrolment claims and 10 failed host proofs. At most 256 live devices per host.
