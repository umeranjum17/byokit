# @byokit/link

Muxr parity is tracked separately. Host policy, relay routing, and streams are available.

Scan a code to pair a phone or browser with the home computer, then talk over one encrypted link. The computer (the
**host**) keeps every credential; a device holds only its own key and a grant, and asks the host to do things.

Noise IK over WebSocket (`noise-handshake` + libsodium; frames sealed by `@noble/ciphers`), in Node, browsers/PWAs
and React Native. No listener, no files, no environment: the app hands the host its sockets and stores. Threat model
and review checklist:
[SECURITY.md](SECURITY.md).

## Host

```ts
import { Host, keyPair } from '@byokit/link';

const host = await Host.open({
  keys: hostKeyFile(path),                // from '@byokit/link/node': made once, 0600, never replaced; or your keychain
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

More host policy, all optional:

- `offer`/`code`/`enrol` take `kind` (e.g. `'browser'`, `'peer'`), `lifetime` (ms; access then ends like a removal)
  and `meta`. The offer carries `role` and `lifetime`, so the device can show what it is agreeing to.
- `allow: (req, device) => boolean` decides every request (e.g. from capabilities kept in `meta`); without it,
  control devices may do anything and view-only ones what `canView` allows.
- `caps: { peer: 16 }` limits devices per kind; `maxDevices` limits them all.
- `answers: { get, put, drop }` keeps completed answers across host restarts. `req.key` is stable per device and retry;
  handlers with transactional effects can store it alongside the effect to avoid repeating work after a crash between
  the handler and `answers.put`.
- `handshakes: { perMinute, perPeer }` limits new handshakes; pass `host.accept(ws, { peer: ip })` to count per source.

`offer({ base: 'https://app.example/pair' })` makes a link a browser can open instead of a bare QR text.
Handler errors are logged on the host (`onError` can receive them). Devices see “Your computer couldn't do that.” unless the handler explicitly throws `new PublicLinkError('A message safe to show.')`.

## Device

```ts
import { DeviceLink, pairWithOffer, pairWithCode } from '@byokit/link';

const grant = await pairWithOffer(scanned, { name: 'Pixel 9', onWords: (w) => show(w) });
// Or pairWithCode(url, typed, { name: 'Pixel 9', onWords: (w) => show(w) });
await secureStore.save(grant);                    // it holds this device's secret key
const link = new DeviceLink(grant, { store: secureStore, onStatus, onEvent });
await link.request('send.message', { text: 'hi' });  // waits through reconnects
await link.request('send.message', { text: 'hi' }, { timeoutMs: 20_000, notValidAfter: Date.now() + 60_000 });
```

- Save `pendingGrant(scanned, { name })` before pairing and pass its key (`pairWithOffer(scanned, { …, key })`): if
  the app dies while the person decides, a `DeviceLink` made from it retries until approval (up to five minutes
  after the offer expires), then forgets it if the host still has not approved.
- `resolve: (url) => …` runs before each dial (e.g. open an SSH tunnel and return `ws://127.0.0.1:<port>/…`);
  `link.addUrl(url)` adds an address found later (a wrong host there just fails its handshake).
- A quiet connection is pinged (`pingMs`, default 20 s) and redialled when the host stops answering; at most
  `maxPending` requests (default 1000) wait at once.
- `link.rekey()` moves the device to a fresh key without a moment where no key works; `link.unpair()` forgets the
  computer and asks it to forget this device.

Statuses: `connecting`, `online`, `offline` (it keeps retrying), `refused` (every address answered with another host key; the grant is
kept, `retry()` or pair again), `removed` (the host removed this device; the grant is forgotten). Every failure is a
`LinkError` with a plain `message` and a `code`. `stop()` rejects unanswered and new requests until `retry()`.
Retry guarantees and their limits: [SECURITY.md](SECURITY.md#known-limits).

For React Native, install a `crypto.getRandomValues` polyfill such as `react-native-get-random-values` (or use
`expo-crypto`) and import it **before** `@byokit/link`. Metro resolves `sodium-universal` to `sodium-javascript`
through its browser field. The device uses the platform's WebSocket and needs no Node globals.

## Streams

For what doesn't fit a request: a terminal pane, a tunnelled TCP connection, a call's audio. A stream is duplex and
carries bytes; each direction has a 256 KB window, so a slow reader holds the writer back instead of filling memory.

```ts
// Host: take streams devices open. `device` is the authenticated grant (one controller per pane…). The stream
// opens first; a thrown `PublicLinkError` ends it with its message, while other errors go to `onError` and end it with `failed`.
const host = await Host.open({ …, stream: (s, req, device) => {
  const pty = panes.attach(req.args.pane, device.id);        // your code
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

View-only devices open only the streams `allow` permits (or `canView` when `allow` is absent). A host without `stream` tells devices so
(`LinkError` `not-supported`), and so does a host older than streams.

On a direct socket, stream bytes go as binary WebSocket messages (without base64 overhead); through a relay, whose
host wrapper is text, the same frames go as base64 text. The host says which in `ready`; everything else stays text.

Speed, measured with Hermes (the CLI, v0.13, on a desktop CPU; `bench/hermes.sh`, not a phone measurement): the device
path opens about 4.8 MB/s of stream bytes on a direct socket and 3.9 MB/s through a relay, where muxr's tweetnacl opens its binary preview tunnel at
about 4.6 MB/s. Frames are sealed with `@noble/ciphers`; sodium-javascript's ChaCha20 managed about 2.5.

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
