<h1 align="center">@byokit/relay</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/relay"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/relay?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node | device side anywhere" src="https://img.shields.io/badge/platform-Node%20%7C%20device%20side%20anywhere-666?style=flat" />
</p>

<p align="center"><strong>A blind relay for <a href="../pair"><code>@byokit/pair</code></a>: the home computer dials out, phones reach it through the relay.</strong><br/>
The home computer (the <b>host</b>) needs no open port. The relay routes link's encrypted frames by host address and cannot
read them. It also keeps what a sleeping phone needs (push notifications), a short code a person can type to find a host,
and the owner's list of which hosts may use it. For apps that pair a phone or browser with a computer over link and want
to reach it away from home.</p>

The one exception to "cannot read": push notification text. The relay can read the title and any content the host
explicitly includes.

Node only (the device side, `@byokit/relay/device`, runs anywhere: no Node APIs, so browsers and React Native too).
Depends on [`@byokit/pair`](../pair) (see [package.json](package.json) for the version); it doesn't change its wire
format or crypto.

## Install

```sh
npm install @byokit/relay @byokit/pair
```

[![npm](https://img.shields.io/npm/v/@byokit/relay?style=flat&label=)](https://www.npmjs.com/package/@byokit/relay) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=relay-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

```sh
npm install @byokit/relay @byokit/pair
```

A relay on loopback with its state in memory, a link host registering through `RelayClient`, and a device that finds the
host by short code and pairs with it:

```ts
import { createServer } from 'node:http';
import { Host, keyPair, pairWithCode, DeviceLink } from '@byokit/pair';
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
| `RelayClient` | The host's side: one outbound socket that proves the host's key and reconnects; `code`, `subscribe`, `unsubscribe`, `notify`, `revoke`, `pending`, `self`, `leave`, `stop` |
| `ownerClient` | The owner's HTTP API: `hosts`, `enrolment`, `revoke`; accepts an injected `fetch` |
| `RelayOwnerError` | HTTP refusal with a numeric `status` and a `code`: `forbidden` (403), `not-found` (404), or `request-failed` |
| `findHost` | The device's side: a short code → the link address to dial (also from `@byokit/relay/device`) |
| `linkUrl` | A relay URL and known host id → the link address to dial (also from `@byokit/relay/device`) |
| `JobChannel` | Host-owned bounded job history: `create`, `follow`, `drop`; replays ordered frames after a cursor |
| `readJobStream` | Portable ordered text/image/usage/end reader (also from `@byokit/relay/device`) |
| `LIMITS` | Per-client-address limits per minute |
| `CLOSE` | WebSocket close codes the relay uses (replaced, not enrolled, bad proof, enrolment, revoked, too many) |
| `isAllowedEndpoint`, `isExpoToken` | Checks for Web Push endpoints and Expo push tokens |
| `MAX_ACTION_REPLY` | The most UTF-8 bytes a notification action's sealed `reply` may carry (8192) |
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
| `POST /relay/v1/push/action` | a device | `{ token, action, reply? }`: a notification's button, with an optional bounded sealed reply, answered by the host |
| `POST /relay/v1/enrolments`, `GET /relay/v1/hosts`, `DELETE /relay/v1/hosts/<id>` | the owner (`Authorization: Bearer <ownerToken>`) | make an enrolment, list and revoke hosts |

Use the typed owner client instead of assembling these requests:

```ts
import { ownerClient, RelayOwnerError } from '@byokit/relay';

const owner = ownerClient('https://relay.example', ownerToken);  // optional third argument: { fetch }
const hosts = await owner.hosts();             // HostRecord plus online and devices
const { token, expires } = await owner.enrolment({ name: 'Build server' }); // name is optional
const removed = await owner.revoke(hostId);    // false if already absent
```

HTTP refusals throw `RelayOwnerError`: `status` is the HTTP status and `code` is `forbidden` for 403,
`not-found` for 404, or `request-failed` for other errors. A missing host on `revoke` returns `false`, as the
server's delete is idempotent. Fetch/network errors pass through. The client refuses redirects and accepts
HTTP or HTTPS relay URLs; use HTTPS outside loopback. Keep the owner token out of devices and public browser code.
BYOKit supplies the library; the app chooses and runs its relay.

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
  store: { load: () => db.revoking(), save: (d) => db.setRevoking(d) },  // pending unsubscribes; default: memory
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
import { findHost, linkUrl } from '@byokit/relay/device';
import { pairWithCode } from '@byokit/pair';
const url = await findHost('https://relay.example', short);   // wss://relay.example/link/v1/<host id>
const grant = await pairWithCode(url, code, { name: 'Pixel 9', onWords: (words) => console.log('Verify on host:', words) });
// With a host id already known, no lookup is needed:
const known = linkUrl('https://relay.example', hostId);
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

`revoke` saves the device to the client's `store` before it drops the grant, then sends the unsubscribe on every
connection (retrying with backoff, 1 s to 30 s, if the relay fails it) until the relay confirms, and resolves then. A
relay that no longer has the host counts as confirmed: its push addresses went with it. `pending()` lists the devices
still waiting and `onRevoked(device)` fires as each is confirmed; `subscribe` refuses a device still pending. If the
client stops first, `revoke` rejects but the unsubscribe stays saved, and the next client on the same `store` sends it.
The default store is memory, so pass a durable one (a 0600 file or a database row, like the relay's own).

A browser subscribes with the relay's Web Push key (`relay.vapidKey`, sent to it over the link). A notification with the
same `id` is deduplicated while the relay runs; a restart can deliver a retried notification twice. Expo tokens a device
dropped (`DeviceNotRegistered`) and Web Push subscriptions that are gone (404, 410) are removed.

Web Push endpoints must use HTTPS on `fcm.googleapis.com`, a subdomain of `push.apple.com`,
`updates.push.services.mozilla.com`, or a subdomain of `notify.windows.com`. `push.hosts` in `Relay.open` can narrow
these destinations (including to an exact subdomain), never expand them. Redirects are not followed, and disallowed
subscriptions restored from storage are removed before delivery.

`RelayClient.notify` sends the title but omits `body` and `data` by default, even if supplied. Pass
`{ includeContent: true }` as its second argument to forward them. Choose a generic title too; see
[SECURITY.md](SECURITY.md) for the push-content boundary and device revoke.

### Sealed notices on a sleeping phone

Seal the real content to the device (`sealNotice` from `@byokit/seal`) and send it as `data` with a generic title. For
Expo tokens, the device also reports its OS when it subscribes, and the notification asks each platform to let the app
replace the generic text:

```ts
import { RelayClient } from '@byokit/relay';
import { sealNotice } from '@byokit/seal';
declare const relay: RelayClient, deviceId: string, token: string, os: 'ios' | 'android', devicePublicKey: Uint8Array;
declare const question: { agent: string; text: string };

await relay.subscribe(deviceId, { expo: token, platform: os }); // the device sends its token and OS over the link
await relay.notify({
  id: 'ask-42', title: 'An agent needs you', data: sealNotice(question, devicePublicKey), urgency: 'high',
  mutableContent: true,  // iOS: the app's Notification Service Extension may rewrite the alert before it shows
  categoryId: 'agent.ask', // the category (buttons) the app registered
  dataOnly: true,        // Android: no title, body or sound; the app opens `data` and presents the notification
}, { includeContent: true });
```

| Option | Expo field | Effect |
|---|---|---|
| `mutableContent` | `mutableContent` (iOS) | APNs `mutable-content`. Without a Notification Service Extension the alert shows as sent. `false` is sent as `false`. |
| `categoryId` | `categoryId` | The registered category, `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`. Not sent with a data-only message. |
| `dataOnly` | title, body, sound and category omitted | Only tokens subscribed with `platform: 'android'`; others (iOS, or no `platform`) get the visible alert. |

Expo puts `data` under the APNs payload's `body` key on iOS, so an extension reads the notice at
`userInfo["body"]["data"]` (`@byokit/seal`'s Swift opener does). A data-only message runs the app's background
notification task; Android may delay it (Doze) and never delivers it to a force-stopped app, so it is not guaranteed.
Without `includeContent`, a data-only message carries only the id, the generic title and any action token, and the app
fetches the details over the link. The app registers the task (`Notifications.registerTaskAsync`) and should show a
notification for each high-priority data message, or Android may lower the priority of later ones. The
content-free preset drops all three options. Web Push is unchanged: the service worker shows what it opens.

With `actions`, each device's notification carries its own one-use `action` token. Pressing a button posts
`{ token, action }` to `/relay/v1/push/action`; the relay asks the host (`onAction`) and waits up to 15 seconds for the
answer, which goes back to the device.

A press may also carry `reply`: one sealed ciphertext (for example a free-text answer sealed to the host's box key).
It must be a non-empty string of at most `MAX_ACTION_REPLY` (8192) UTF-8 bytes of ciphertext; anything else is refused
before the token is spent, so a corrected press still works. The relay forwards the string unchanged to `onAction` as
`PushAction.reply` and never reads or stores it. The host opens it with its own key; the relay's content boundary is
unchanged.

## Limits

Per client address, per minute, as in muxr's relay: 60 WebSocket connections, 10 short-code lookups,
20 button presses, 10 enrolment claims and 10 failed host proofs. At most 256 live devices per host.

## Links

- [byokit](../../README.md): the other packages
- [`@byokit/pair`](../pair): pairing and the encrypted link this relay carries
- [SECURITY.md](SECURITY.md): what the relay can and cannot see
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).

### Self-hosted signup and notification policy

The embedding app runs the server and supplies these options; the kit operates no relay:

```ts
import { Relay, contentFreeNotify } from '@byokit/relay';

const relay = await Relay.open({
  signup: { open: true, maxHosts: 1000 },
  notify: contentFreeNotify('There is news'),
  limitKey: ({ host }) => host, // proven enrolment or valid action token; otherwise per-IP
});
```

Signup defaults to `'enrol'`. `{ open: false, maxHosts: 1000 }` also requires enrolment.
Open signup requires proof of the host key and limits automatic registrations against the current total host
count, atomically with persistence. Existing hosts reconnect at capacity. Revoking a host frees a slot; with open
signup enabled, that key can register again. Owner `admit()` remains an explicit override of the signup cap.
Invalid caps (not positive safe integers) fail when opening the relay.

`notify(notification, host)` receives a validated notification and the authenticated host id. Return a notification
to transform it, or `undefined` to suppress it (`{ sent: 0 }`); promises are supported. Exceptions and invalid output
reject the request without delivery. The content-free preset uses a fixed title, SHA-256 retry ids, no body, data or
buttons, and preserves recipient selection, urgency and TTL. Deduplication uses the filtered id; keep transformations
stable across retries. Hashes hide readable ids but do not protect guessable ids from dictionary attacks.

`limitKey({ kind, request, host })` selects a bucket within each existing one-minute `LIMITS` category. Returning
`undefined` uses the usual per-IP bucket (`trustProxy` controls forwarded addresses). `host` exists only after valid
key proof during registration or for an unexpired push-action token. WebSocket upgrades, failed proofs and code
lookups have no authenticated host. An app can map requests to tenant buckets using its own trusted authentication;
never trust a caller's claimed host or tenant header. Custom keys replace per-IP buckets, so keep pre-authentication
traffic on address limits unless a trusted tenant boundary is available.

For reconnect reconciliation, provide a durable `RelayClient.store`, revoke removed devices through
`RelayClient.revoke`, and resend current subscriptions once online. Pending unsubscribe records retry on every
connection until acknowledged; the relay's store must remain durable too.



## Host enrolment metadata and self-service

The owner can attach up to 4096 UTF-8 bytes of JSON to an enrolment through `relay.enrolment({ meta })` or
`ownerClient(url, token).enrolment({ meta })`. The kit treats it as opaque data; URL meanings belong to the app:

```ts
import type { Host } from '@byokit/pair';
import { ownerClient, RelayClient, type RelayClientStore } from '@byokit/relay';

async function relayExample(host: Host, ownerToken: string, pendingStore: RelayClientStore) {
  const enrolment = await ownerClient('https://relay.example', ownerToken).enrolment({
    name: 'Kitchen computer',
    meta: { enrolmentUrl: 'https://relay.example/enrol', webUrl: 'https://app.example' },
  });
  const client = new RelayClient(host, { url: 'wss://relay.example/relay/v1/host', enrol: enrolment.token, store: pendingStore });
  const { host: record, devices } = await client.self();
  // record.meta is also available as client.meta after ready, including on reconnect.
  // devices counts live relay connections; the host alone knows which link grants authenticate them.
  await client.leave();
}
```

Metadata stays on the owner's and enrolled host's side. The relay neither fetches these URLs nor sends metadata to
phones. `self()` needs the host's key proof, not the relay owner's token, and returns only `{ host: HostRecord, devices }`.
`leave()` removes the host registration, all its push subscriptions, action tokens and short codes, closes its devices,
clears confirmed pending unsubscriptions from the client's store, and stops. A failed relay save rejects without
removing authority. Requests retry on reconnect while the client runs; after a host restart the app calls `leave()` again.
It does not remove local link grants. With the default enrolment-only signup, returning after leaving requires a new owner enrolment.
An explicitly open signup policy permits the key to register again, subject to its host cap.
Open signup still consumes an explicitly supplied enrolment and retains its owner-set name and metadata.

## Resumable streamed jobs

Link's byte streams carry progressive output, including binary data, through this relay. A byte stream ends with
its socket, however: reopening it alone cannot recover output missed while offline. `JobChannel` adds a host-owned
frame log. Every frame has the same `job` id and an increasing `seq` starting at 1, with a `type` of `text`, `image`,
`usage` or `end`. `follow` replays only frames after `after` and then follows new output. Reopening a stream does
not restart execution. A job belongs to the authenticated link grant id; another device cannot read it even if it
guesses the job id. Keep using `Host.allow` for your app's operation policy too.

This channel selects no provider and makes no model or tool calls. The app feeds output from its chosen runtime
kit into the writer. Offer subscriptions in plain words and on by default. Label any API key route **API key
(billed per use)** and require explicit opt-in before starting it. Sign-in tokens and provider keys stay on the
execution device: never put them in job inputs, frames, ids, error text, notifications or logs. Usage is a numeric
record supplied by the runtime, such as `{ inputTokens, outputTokens }`; the channel never estimates it.

Host integration (pass this host to `RelayClient` as in the quickstart):

```ts
import { Host, type KeyPair, type PairRequest } from '@byokit/pair';
import { JobChannel, type JobPart, type JobWriter, type JobCursor } from '@byokit/relay';

type Output = Exclude<JobPart, { type: 'end' }>;

async function jobHost(
  keys: KeyPair,
  confirm: (request: PairRequest) => boolean | Promise<boolean>,
  // App adapter to its selected runtime kit; validate input and billing consent before returning output.
  execute: (input: unknown, device: string) => AsyncIterable<Output>,
) {
  const jobs = new JobChannel({ maxJobs: 64, maxFrames: 4096, maxBytes: 8 * 1024 * 1024 });
  async function produce(job: string, device: string, writer: JobWriter, input: unknown) {
    try {
      for await (const part of execute(input, device)) writer.append(part);
      // The adapter emits the runtime's final usage record before completion.
      writer.append({ type: 'end' });
    } catch {
      // Only public words cross the link; never transmit the caught exception.
      try { writer.append({ type: 'end', error: 'Your computer could not finish that.' }); }
      catch { jobs.drop(job, device); } // full history: explicit failure, no silent lost frames
    }
  }
  const host = await Host.open({
    keys, name: 'Your computer', confirm,
    allow: (request, device) => device.role === 'control' && ['job.start', 'job.follow'].includes(request.op),
    handle: (request, device) => {
      const { job, input } = request.args as { job: string; input: unknown };
      const writer = jobs.create(job, device.id); // create once, before any execution
      void produce(job, device.id, writer, input);
      return { job };
    },
    stream: (stream, request, device) => jobs.follow(stream, request.args as JobCursor, device.id),
  });
  return { host, jobs };
}
```

The device starts a job with an app-generated id, then opens a follower while link is online. This example also
works in a browser or React Native; import the reader from `@byokit/relay/device`, avoiding the Node server entry:

```ts
import type { DeviceLink } from '@byokit/pair';
import { readJobStream, type JobFrame } from '@byokit/relay/device';

async function startJob(link: DeviceLink, job: string, input: unknown) {
  await link.request('job.start', { job, input });
  return job;
}

async function followJobOnce(
  link: DeviceLink, job: string, after: number,
  // Apply output and persist frame.seq together; skip already-applied seq values on local retry.
  applyAndSave: (frame: JobFrame) => Promise<void>,
) {
  const stream = await link.stream('job.follow', { job, after });
  return readJobStream(stream, { job, after }, async (frame) => {
    await applyAndSave(frame);
    // text: append frame.text; image: frame.data is Uint8Array with frame.mime;
    // usage: save frame.usage; end: finish the job, displaying only the public frame.error if present.
  });
}
```

On socket loss the reader rejects. Wait for `DeviceLink`'s `onStatus('online')`, reload the last **applied** sequence,
and call `followJobOnce` again; serialize these attempts and handle their rejections. Do not call `job.start` to
resume. Link retries an unanswered start request within the same device session; a retained id cannot be created
twice. If a start times out ambiguously, follow the known job id before deciding whether to start new work.
Returning from the reader means the transport ended cleanly, including a cursor already at a completed job's end.
Use the `end` frame in your saved state as the job's completion signal. Failure text is app-supplied public text.

The image wire field is base64url inside the encrypted stream; the reader returns the original bytes. A frame is
limited to `MAX_JOB_FRAME_BYTES` (1 MiB of UTF-8 JSON, excluding its newline), so large images must be supplied as
ordered parts and assembled by the app. Link chunks stream writes independently; its 256 KiB window still provides
backpressure. Text boundaries are preserved, even when a UTF-8 character or frame crosses link chunks.

History is in memory on the host, bounded by `maxJobs`, per-job `maxFrames` and aggregate `maxBytes`. Full history
rejects an append without consuming a sequence; configure limits for expected output and handle refusal. The log
does not silently evict frames. Call `jobs.drop(job, deviceId)` when your retention or cancellation policy permits
it, and when removing that device; it releases memory and ends existing followers. Appending after `end` or `drop`
fails. A missing job or a cursor beyond retained history ends the follower with a public error.

Reconnect recovery works while the host's `JobChannel` stays alive, even if the relay restarts. Host-process crash
recovery, durable execution, cancellation of the underlying runtime, provider choice, billing consent, application
input validation and transactional output/cursor storage belong to the embedding app or runtime kit. This channel
does not add a database, hosted queue, or execute a second run when a transport reconnects. The relay remains blind
to job ids, frames, images and usage; no job credential or content is logged by the channel.
