# @byokit/link

Scan a code to pair a phone or browser with the home computer, then talk over one encrypted link. The computer (the
**host**) keeps every credential; a device holds only its own key and a grant, and asks the host to do things.

Noise IK over WebSocket (`noise-handshake` + libsodium), in Node, browsers/PWAs and React Native. No listener, no
files, no environment: the app hands the host its sockets and stores. Threat model and review checklist:
[SECURITY.md](SECURITY.md).

## Host

```ts
import { Host, keyPair } from '@byokit/link';

const host = await Host.open({
  keys,                                   // keyPair() once, then keep it in the OS keychain or a 0600 file
  name: 'Kitchen computer',
  grants: { load: () => db.grants(), save: (g) => db.setGrants(g) },
  confirm: ({ name, words, role }) => ui.ask(`Pair ${name}? Check it shows “${words}”.`),
  canView: (req) => req.op.startsWith('get.'),     // what view-only devices may ask; default nothing
  handle: (req, device) => app.run(req.op, req.args, device),
});
wss.on('connection', (ws) => host.accept(ws));   // any WebSocket server; bind it to loopback/tailnet by default

const { text } = host.offer({ role: 'control', urls: ['ws://192.168.1.20:7300/link'] });  // show as a QR
const { code } = host.code({ role: 'view' });     // or a code to type: "7KQ4-M2XP-9RTH"
host.devices(); await host.revoke(id); host.broadcast(event);
```

`offer({ base: 'https://app.example/pair' })` makes a link a browser can open instead of a bare QR text.
Handler errors reveal their message to devices only when the thrown error has `expose === true`; otherwise the device sees “Your computer couldn't do that.”

## Device

```ts
import { DeviceLink, pairWithOffer, pairWithCode } from '@byokit/link';

const grant = await pairWithOffer(scanned, { name: 'Pixel 9', onWords: (w) => show(w) });
// Or pairWithCode(url, typed, { name: 'Pixel 9', onWords: (w) => show(w) });
await secureStore.save(grant);                    // it holds this device's secret key
const link = new DeviceLink(grant, { store: secureStore, onStatus, onEvent });
await link.request('send.message', { text: 'hi' });  // waits through reconnects; a retry runs once
```

Statuses: `connecting`, `online`, `offline` (it keeps retrying), `refused` (something else answered; the grant is
kept, `retry()` or pair again), `removed` (the host removed this device; the grant is forgotten). Every failure is a
`LinkError` with a plain `message` and a `code`.

## Through a relay

Frames are the same bytes on every path; a relay only routes them and cannot read them.

- A device dials `wss://<relay>/link/v1/<host id>` (`host.id`, a hash of the host key) and sends and receives bare
  frames, exactly as on a direct socket. Put that address in the offer's `urls`.
- The host keeps one socket to the relay and passes it to `host.relay(ws)`. Each message on it is
  `{"c": "<connection id>", "f": "<frame>"}`, or `{"c": "…", "end": <code>}` when either side closes.
- The relay authenticates the host's socket and limits abuse its own way. It never needs a device id: the host checks
  devices itself on every handshake.

The relay is not part of v0.1.

## Moving already-paired devices (muxr)

muxr's devices (about 25) are paired with signed grants and shared-root envelopes. They move without pairing again:

1. The muxr host starts a byokit `Host` beside its current transport (dual stack).
2. Over each device's **existing authenticated channel**, the device generates a byokit key pair, sends its public
   key, and receives the host's public key and link addresses.
3. The host calls `host.enrol({ key, name, role, meta })`: `observe` becomes `view`, `control` stays `control`, and
   `meta` keeps muxr's device id and kind. The device stores a `DeviceGrant` and connects with `DeviceLink`.
4. Once a device connects over byokit, the host stops accepting its old transport; when every device has moved (or
   after a set period), the old transport is turned off and remaining devices pair again with a QR.

Devices that are offline for the whole period pair again. Revocation on either side during the move revokes both.
