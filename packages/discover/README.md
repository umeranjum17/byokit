<h1 align="center">@byokit/discover</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/discover"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/discover?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node | React Native" src="https://img.shields.io/badge/platform-Node%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>The addresses a phone can dial the home computer on.</strong><br/>
For <code>@byokit/link</code>'s <code>offer({ urls })</code>: Tailscale Serve, direct Tailscale, a private overlay
network or the LAN. On Node it can also advertise the computer over mDNS; on a phone (React Native) it browses the
mDNS services around it.</p>

Formerly `@byokit/reach`, which stays published as a deprecated shim re-exporting this package through 0.7.x
and is removed in 0.8.0.

## Install

```sh
npm install @byokit/discover
```

[![npm](https://img.shields.io/npm/v/@byokit/discover?style=flat&label=)](https://www.npmjs.com/package/@byokit/discover) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=discover-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

```sh
npm install @byokit/discover
```

Work out the addresses for a server on port 8792, listen where reach says, and put the addresses in the pairing
offer. Persist `ingress` and pass it back as `previous` next time.

```ts
import { reach } from '@byokit/discover';

const { urls, bind, ingress, pendingCleanup } = await reach({ port: 8792, previous: saved.ingress });
server.listen(8792, bind);        // loopback behind Serve, selected IP for direct Tailscale, wildcard for LAN/private
saved.ingress = ingress;
if (pendingCleanup) saved.pendingCleanup = pendingCleanup; // retry unserve() later
const { text } = host.offer({ role: 'control', urls });     // show `text` as a QR
```

The LAN route with a made-up interface list, so it never touches Tailscale or the network. Docker's bridge is
skipped; the NetBird-style `wt0` address is a `private` route, not LAN:

```ts
import type { NetworkInterfaceInfo } from 'node:os';
import { reach, routes } from '@byokit/discover';

const nic = (address: string): NetworkInterfaceInfo =>
  ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: `${address}/24` });
const interfaces = { en0: [nic('192.168.1.20')], docker0: [nic('172.17.0.1')], wt0: [nic('100.90.1.2')] };

console.log(routes(interfaces));
console.log(await reach({ port: 8792, via: 'lan', interfaces }));
```

```text
{
  lan: [ '192.168.1.20' ],
  private: [ { address: '100.90.1.2', interface: 'wt0' } ],
  tailscale: []
}
{ urls: [ 'ws://192.168.1.20:8792' ], bind: '0.0.0.0' }
```

## API at a glance

| Export | What it does |
|---|---|
| `reach({ port, via?, previous?, tailscale?, interfaces?, address? })` | The dial `urls`, the `bind` address, and the Serve `ingress` to persist (plus `pendingCleanup` when a removal failed) |
| `directRoutes({ port, listen?, interfaces?, tailnetIPs?, hosts?, path? })` | Multiple direct listener `hosts` and pairing `urls`, with explicit loopback/tailnet/LAN scopes |
| `phoneNetwork({ nativeModule? })` | Phone Wi-Fi/cellular transports and explicit VPN state (`yes`, `no`, `unknown`) |
| `nativeAddresses({ nativeModule? })` | IPv4 interface evidence including actual prefix lengths; Node reads its interfaces by default |
| `routeOf(url)` | Address hint: `home`, `tailscale`, `relay`, `loopback` or `unknown` |
| `observe({ urls, priorEvidence?, nativeModule?, addresses?, probe? })` | Current prefix evidence and a bounded probe, retaining the host’s prior evidence |
| `probe(url, { timeout?, fetch? })` | Typed `answers`, `refused`, `timeout` or `unknown` observation |
| `routes(interfaces?, tailnetIPs?)` | This computer's IPv4 routes: `lan` addresses, `private` overlay addresses and `tailscale` addresses |
| `recommend({ port?, interfaces?, tailscale?, state?, serve?, lan?, private?, current? })` | Every route in everyday words, recommended first: `{ via, recommended, sentence, needs, disabledReason? }` per route |
| `advertise({ type, port, name?, txt?, addresses? })` | Publishes `_<type>._tcp` over mDNS (Node), using only selected addresses; returns `{ stop }` |
| `tailscaleState({ bin?, timeoutMs? })` | Non-throwing installation, backend, sign-in, key expiry, peer and address diagnostics |
| `needsSignin(status)`, `isPeer(status, ip)` | Pure helpers for raw `tailscale status --json`: explicit login state and peer IP membership |
| `tailscaleStatus`, `tailscaleName`, `magicDnsName` | Read the local Tailscale state and this machine's MagicDNS name |
| `inspectServe`, `serveRootProxy` | Check who holds the Serve root: `free`, `ours`, `occupied`, `funnel`, `disabled` or `inconclusive` |
| `serve`, `unserve` | Make or remove the app's Serve mapping, with ownership checks |
| `SERVE_OWNED_ERROR`, `FUNNEL_ERROR` | The error messages for a taken root and a root with Funnel on |
| `browse({ type })`, `scan({ type, ms })` | React Native entry only: discover mDNS services, streamed or time-boxed |
| Types | `Via`, `Reach`, `RecommendVia`, `RecommendEntry`, `RecommendOptions`, `PrivateRoute`, `ServeIngress`, `ServeRoot`, `TailscaleOptions`, `TailscaleState`, `TailscalePeer`, `Bonjour`, `BonjourRecord`; on React Native `BrowseService`, `BrowseHandle`, `BrowseOptions`, `BrowseEvents`, `BrowseEventName`, `ZeroconfLike` |

## Routes

`via` picks the route:

| `via` | Address | Server binds |
|---|---|---|
| `auto` (default) | Tailscale Serve if Tailscale is installed, otherwise LAN | as below |
| `tailscale` | `wss://<MagicDNS name>` through Tailscale Serve | `127.0.0.1` |
| `tailscale-direct` | `ws://<tailnet IP>:<port>` | the selected tailnet IP |
| `private` | another overlay network (NetBird, WireGuard, ZeroTier, …) | `0.0.0.0` |
| `lan` | private IPv4 addresses on physical-looking interfaces (no known Docker, VM or VPN bridges) | `0.0.0.0` |

Direct Tailscale binds the first CGNAT IPv4 address in `Self.TailscaleIPs`, keeping the LAN closed.
Pass `address` with `via: 'tailscale-direct'` to select another IPv4 address from that same list;
foreign addresses and wildcard binds are refused before removing an existing Serve mapping.

`routes(interfaces, tailnetIPs)` includes named Tailscale interfaces in `tailscale`; pass the
snapshot's `ips` to identify Tailscale addresses on macOS `utun` interfaces too. Other overlays,
including CGNAT addresses without Tailscale evidence, stay in `private`. The function runs no CLI.

IPv6-only networks: not yet.

Tailscale is transport only. Link's handshake still checks every device key.

### Recommend

`recommend()` lists one entry per concrete route (`tailscale`, `tailscale-direct`, `private`, `lan`) with the
recommended one first, so the recommendation order and the everyday copy live in one place. `sentence` and `needs`
come from ui-core's `routeChoices()`; only availability is added here. `auto` is not a route: it picks the
recommended entry. Pass `state`, `serve`, `lan` and `private` fakes to decide without touching Tailscale or the
network; with no options it probes this computer (`tailscaleState`, `inspectServe` on `port`, `routes`).

```ts
import { recommend } from '@byokit/discover';

const entries = await recommend({
  state: { installed: true, backendState: 'Running', needsSignin: false, dnsName: 'dev.tailnet.ts.net', ips: ['100.64.0.1'] },
  serve: { status: 'free' },
  lan: ['192.168.1.20'],
  private: [],
});
console.log(entries.map((e) => `${e.recommended ? '●' : '○'} ${e.via}: ${e.sentence}`));
```

```text
● tailscale: Your phone reaches this computer from anywhere.
○ tailscale-direct: Same as above without Tailscale Serve. Pick this if Serve is already used on this computer for something else.
○ private: Pick this if this computer and phone are already on one.
○ lan: Easiest. Works while your phone is on the same Wi-Fi as this computer. Nothing else to install.
```

The order is the current healthy route (pass it as `current`), then Tailscale Serve — direct Tailscale when the Serve
root is taken, disabled, funnelled, or nameless — then a private overlay, then Same Wi-Fi. Tailscale installed but
signed out stays selectable, with sign-in in `needs`, while Same Wi-Fi is recommended. Nothing ready means no entry
is recommended and every entry carries its `disabledReason`.

## Multiple direct listeners

`directRoutes` is synchronous and runs no CLI, Serve or listener. By default it selects loopback plus
classified tailnet addresses. A supplied `listen` enables only its true scopes. LAN binds the individual
LAN addresses, so enabling LAN does not implicitly open unrelated overlays or disabled scopes.
Pass `tailscaleState().ips` as `tailnetIPs` for unnamed interfaces. Addresses must exist in the interface
snapshot; CLI evidence alone does not create a listener. Refresh the snapshot and reconcile listeners
when the network or pairing-window policy changes.

```ts
import type { NetworkInterfaceInfo } from 'node:os';
import { directRoutes } from '@byokit/discover';

const nic = (address: string): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0',
  family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: `${address}/24` });
const umer = directRoutes({
  port: 8792, path: '/link',
  interfaces: { en0: [nic('192.168.1.20')], utun3: [nic('100.101.2.3')] },
  tailnetIPs: ['100.101.2.3'],
  listen: { loopback: true, tailnet: true, lan: true },
});
console.log(umer.hosts); // ['127.0.0.1', '100.101.2.3', '192.168.1.20']
console.log(umer.urls);  // ['ws://192.168.1.20:8792/link', 'ws://100.101.2.3:8792/link']
// Create a server for each host; give urls to link's offer only after those servers listen.
```

`hosts` overrides scope selection with explicit pinned listeners (pass an array rather than a comma-separated
string). An explicitly pinned `0.0.0.0` deliberately opens every IPv4 interface; its dial URLs expand only
to classified LAN/tailnet addresses. An empty `hosts` array returns no listeners or URLs. Dial URLs put LAN
before tailnet, remove duplicates, and include loopback only when there is no remote candidate.

## Phone route evidence (React Native and Node)

Use `@byokit/discover/react-native` explicitly or the root `react-native` export condition. Both expose
`nativeAddresses`, `routeOf`, `observe`, `probe` and `phoneNetwork` with the same types as Node. These functions import no
Node modules. Expo apps use the bundled `ByokitReach` native module on Android/iOS by default. Rebuild the native
binary after installing @byokit/discover. Android reads interface prefixes and NetworkCapabilities; iOS reads
interface netmasks and NWPath transports. Bare React Native apps can supply their native address module
through `nativeModule` on each call. This supports existing modules and fakes without a global singleton. A reader implements `addresses(): Promise<NativeAddress[]>`, returning
`{ address, prefixLength?, interface? }` for each IPv4 interface. Obtain `prefixLength` from the platform’s
interface prefix/netmask, never a guessed /24. A legacy string-only reader needs an adapter and cannot
supply prefix evidence until its native implementation exposes it.

This example runs without native networking (use the Node root import to run it under Node):

```ts
import { nativeAddresses, routeOf, observe, probe } from '@byokit/discover/react-native';
import type { NativeAddressesModule } from '@byokit/discover/react-native';

const umer: NativeAddressesModule = {
  addresses: async () => [{ address: '192.168.1.2', prefixLength: 23, interface: 'wlan0' }],
};
const fakeFetch: typeof fetch = async () => new Response('', { status: 503 });
console.log(await nativeAddresses({ nativeModule: umer }));
console.log(routeOf('ws://100.64.0.3:8792/link')); // 'tailscale'
console.log(await probe('ws://192.168.0.20:8792/link', { timeout: 4000, fetch: fakeFetch }));
const facts = await observe({
  urls: ['ws://192.168.0.20:8792/link', 'ws://100.64.0.3:8792/link'],
  nativeModule: umer,
  priorEvidence: { anywhere: 'anywhere', peer: true, reached: { tailscale: 123 } },
  probe: { timeout: 4000, fetch: fakeFetch },
});
console.log(facts.home, facts.target, facts.knock?.state); // true, LAN URL, 'answers'
```

For the VPN/wrong-network banner, `phoneNetwork()` returns a fresh active network snapshot:

```ts
import { phoneNetwork } from '@byokit/discover/react-native';

// Expo: const network = await phoneNetwork();
// Runnable fake for Umer's phone (Node can use the root import):
const network = await phoneNetwork({ nativeModule: {
  phoneNetwork: async () => ({ onWifi: true, cellular: false, vpnActive: 'yes' }),
} });
console.log(network); // { onWifi: true, cellular: false, vpnActive: 'yes' }
```

Android uses the active network's `TRANSPORT_WIFI`, `TRANSPORT_CELLULAR` and `TRANSPORT_VPN` capabilities;
multiple transport flags can be true. iOS uses NWPath for Wi-Fi/cellular and always returns `vpnActive: 'unknown'`.
No native reader, a failed read or unavailable path yields `{ onWifi: false, cellular: false, vpnActive: 'unknown' }`;
false transport flags in that fallback do not prove a network is absent. Node returns that fallback unless a
reader is injected. This snapshot never establishes that a particular peer can be reached. The package's
native manifest supplies Android's normal `ACCESS_NETWORK_STATE` permission; no runtime permission dialog
is needed. Expo autolinking discovers the bundled module; install `expo-modules-core` in a native app if it
is not already present. JS-only environments can inject readers; all native loading is deferred until used.

`observe` compares the host’s home IPv4 address against the phone’s actual interface prefix. It prefers a
matching home URL, otherwise a tailnet URL when the snapshot includes a CGNAT address. `home` is unknown
(`undefined`) without usable prefix evidence; `vpn` is unknown without addresses. `tailnet` means a
candidate URL exists; `vpn` means a local CGNAT address exists. CGNAT and `.ts.net` classification are route
hints, not proof of Tailscale, a shared peer, Wi-Fi association or reachability. `routeOf` identifies relay
URLs by `/link/v1/` and returns `unknown` for malformed/unsupported or other public URLs. IPv6 evidence is
not yet supported. `priorEvidence` retains what the authenticated host previously said; it is not refreshed
by this observation. `addresses` can supply a snapshot directly; Node defaults to its own IPv4 interfaces.
An unavailable/failed native module gives an empty snapshot and never invents network evidence.

`probe` maps WebSocket URLs to HTTP(S) and preserves their path. Every HTTP status means `answers`, not
an authenticated link. An explicit `ECONNREFUSED` means `refused`; generic native fetch errors (including
possible DNS/TLS failures) mean `unknown`. `timeout` bounds the operation even when fetch ignores abort.
The default bound is 4000 ms. A probe is an active request only to the URL the caller passes (or the candidate
`observe` selects); it never runs the Tailscale CLI, signs in or changes Serve. Inject `fetch` for offline tests.
Apps decide their own offline wording and still authenticate with link.

## Tailscale rules

These are the rules from muxr's decision 0004.

- **Never Funnel.** Setup uses `tailscale serve --yes --bg --https=443 http://127.0.0.1:<port>`, which
  is visible only inside the tailnet. A root already enabled for Funnel is refused, including when its proxy matches
  the recorded mapping; turn Funnel off before changing routes or DNS names.
- **The server stays on loopback** behind Serve (`bind: '127.0.0.1'`).
- **The machine's own `Self.DNSName` is used.** A missing or invalid MagicDNS name is an error. A logged-out or
  broken Tailscale is an error too. Neither one falls back to the LAN without being asked.
- **An unrecorded root handler is refused.** If `/` on `<name>:443` already has any handler, `reach` throws unless
  `previous` records the matching app-created mapping. Pick `tailscale-direct` or remove an unrelated mapping yourself.
- **Ownership fingerprint.** Persist the returned `ingress` (`{ kind, port, dnsName, proxy }`) and pass it as `previous`.
  `unserve` and `reach({ previous })` remove only `/` while it still points at that proxy; sibling paths remain.
  On a DNS rename, removal of the recorded old root is attempted before the new one is served; a failed cleanup
  returns its fingerprint in `pendingCleanup`, except that Funnel on the old root stops the transition. After setup
  or removal, the root is inspected again; an occupied root after setup is reported without further changes, while
  failed cleanup on a route switch retains `pendingCleanup`.
  The Tailscale CLI has no compare-and-set: a change between inspection and a write can still be overwritten.
  Verify-after-write detects a conflicting final state but cannot eliminate that race.
- **Direct fallback and rollback.** If Serve is disabled on the tailnet (the error includes the admin link), times
  out, or is taken, use `via: 'tailscale-direct'`. With `previous`, that also removes the mapping this package made.
  If cleanup cannot be verified, the requested route is still returned with `pendingCleanup: previous`; persist that
  fingerprint and retry `unserve(pendingCleanup)` later. `auto` also retains `previous` when Tailscale disappears
  and it falls back to LAN. An explicit route switch checks for addresses before removing a working Serve mapping.
  A successful cleanup omits `pendingCleanup`.
  If a Serve write succeeds but its status cannot be verified, the thrown error also carries
  `error.pendingCleanup`; persist it before reporting the error, then inspect or retry cleanup later.

The CLI is `tailscale` on `PATH`, then the macOS app. Pass `tailscale: { bin, timeoutMs }` to choose another. The
lower-level steps are exported too: `tailscaleStatus`, `tailscaleName`, `inspectServe`, `serve`, `unserve`, and
`routes` for the interface list.

For a connection picker, `await tailscaleState()` returns `{ installed, backendState, needsSignin, reason,
dnsName, ips, keyExpiry?, Peer? }` without throwing. `backendState`, `reason` and the normalized `dnsName` can be absent when unknown.
Missing CLI, timeouts, malformed JSON and daemon failures are diagnostic results; they never set up Serve or sign in.
`needsSignin` is true only for `NeedsLogin`; `NeedsMachineAuth` instead asks for admin approval, and `Stopped`
does not mean logged out. The existing `tailscaleStatus()` still throws on CLI failure.

`keyExpiry` preserves a valid `Self.KeyExpiry` date string; the host chooses how to label an expired key.
`Peer` is a validated map of `{ TailscaleIPs, DNSName?, Online? }`, absent when unavailable and
empty when the CLI reports an empty map. Extra fields and malformed entries are discarded.

The pure helpers take **raw status JSON**; `isPeer` also accepts the snapshot's typed `Peer` map. `isPeer(status, ip)`
checks `Peer[*].TailscaleIPs`, accepts an IPv4-mapped socket address (`::ffff:100.64.0.2`), and excludes `Self`.
Offline peers still count as peers. Peer membership is a discovery hint: link's handshake must authenticate the device.

## mDNS

### Advertise (Node)

`advertise({ type, port, name?, txt?, addresses? })` publishes `_<type>._tcp` with
[bonjour-service](https://www.npmjs.com/package/bonjour-service) and returns `{ stop }`. Put the dial URL in `txt`.
The kit filters bonjour-service's A/AAAA records to `addresses`, defaulting to `routes().lan`, so Docker, VPN and
tailnet addresses are excluded by default. An explicit list can select interface addresses including IPv6; only
addresses bonjour-service generates can be published. An empty list publishes no A/AAAA records. The selected list
is snapshotted when advertising starts, and the same filter applies to goodbye records on stop. Discovery metadata
(PTR, SRV and TXT) is preserved. A device that finds the wrong computer fails link's handshake, because the host key is pinned.

```ts
import { advertise } from '@byokit/discover';

const ad = await advertise({ type: 'muxr', port: 8792, txt: { url: 'ws://192.168.1.20:8792' } });
// later
await ad.stop();
```

### Browse (React Native)

Under React Native (the package's `react-native` export condition), `@byokit/discover` also browses the LAN so an app
can find services without typing an address:

```ts
import { browse, scan } from '@byokit/discover';

// Stream discovery: start, then stop when done.
const found = browse({ type: 'muxr' });                  // protocol 'tcp', domain 'local.' by default
found.on('found', (s) => console.log(s.name, s.addresses, s.port, s.txt));   // first resolve of a name
found.on('updated', (s) => console.log('refreshed', s.name));                // a known name resolved again
found.on('lost', (name) => console.log(name, 'left'));
found.on('error', (error) => console.log(error.message));
found.on('stopped', ({ reason }) => console.log(reason)); // 'preempted' if another browse starts
found.stop();                                            // idempotent

// Time-boxed: collect for N ms, then stop. Later resolves replace the earlier entry, first-seen order.
const hosts = await scan({ type: 'ssh', ms: 8000 });     // rejects on error or preemption
```

A `BrowseService` carries `name`, `host`, `addresses`, `port` (`0` when the platform gave none) and `txt` (string
values only). The pinned `react-native-zeroconf` dependency (`0.14.0`) is supplied by @byokit/discover, not the app.

- **One browse at a time.** One native browser runs one browse at a time. Starting another `browse` or `scan`
  preempts the current handle, including when both request the same type: it receives one `stopped` event with
  `{ reason: 'preempted' }`, loses its known services, and does not resume. A preempted `scan` rejects; callers
  needing continuous discovery must start a fresh browse after their other scan finishes.
- **Event matching.** Resolved events must identify the active service type in `fullName`; removals apply only to
  names that browse has found. Native errors are ignored for one second after preemption. The native module
  supplies no scan ID: an untyped late removal for a name reused by the new browse, or an error after that second,
  can still be attributed to the new scan; a real error during the quiet second is also ignored.
- **Entries.** The default Node entry does not import the native module; use the `react-native` export condition for
  browsing. Expo apps must rebuild their native binary after adding @byokit/discover.
- **Android emulator.** mDNS multicast does not work on the emulator; test discovery on a real device.

## Tests

`test/reach.test.ts` ports muxr's `checkTailscaleIngress` and uses a fake tailscale CLI that logs every call. The real
binary never runs, and no packet goes out: mDNS advertise is tested with a fake publisher, and the React Native
browse API with a fake zeroconf module. `test/recommend.test.ts` covers the recommendation order with injected
state, Serve-root and interface fakes, plus one live-probe run against the fake CLI.

## Links

- [byokit](../../README.md): the other packages and the examples
- [`@byokit/link`](../link): pairing and the encrypted link these addresses are for
- [`examples/herdr-kit`](../../examples/herdr-kit): a Herdr host that picks a `via` route and persists the Serve `ingress`
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).
