# @byokit/reach

The addresses a phone can dial the home computer on, for `@byokit/link`'s `offer({ urls })`: Tailscale
Serve, direct Tailscale, a private overlay network or the LAN. It can also advertise the computer over mDNS
and, on a phone, browse the mDNS services around it.

```ts
import { advertise, reach } from '@byokit/reach';

const { urls, bind, ingress, pendingCleanup } = await reach({ port: 8792, previous: saved.ingress });
server.listen(8792, bind);        // '127.0.0.1' behind Serve, '0.0.0.0' otherwise
saved.ingress = ingress;
if (pendingCleanup) saved.pendingCleanup = pendingCleanup; // retry unserve() later
const code = host.offer({ urls });
```

`via` picks the route:

| `via` | Address | Server binds |
|---|---|---|
| `auto` (default) | Tailscale Serve if Tailscale is installed, otherwise LAN | as below |
| `tailscale` | `wss://<MagicDNS name>` through Tailscale Serve | `127.0.0.1` |
| `tailscale-direct` | `ws://<tailnet IP>:<port>` | `0.0.0.0` |
| `private` | another overlay network (NetBird, WireGuard, ZeroTier, …) | `0.0.0.0` |
| `lan` | private IPv4 addresses on physical-looking interfaces (no known Docker, VM or VPN bridges) | `0.0.0.0` |

IPv6-only networks: not yet.

Tailscale is transport only. Link's handshake still checks every device key.

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
- **Ownership fingerprint.** Persist the returned `ingress` (`{ port, dnsName, proxy }`) and pass it as `previous`.
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

## mDNS

### Advertise (Node)

`advertise({ type, port, name?, txt? })` publishes `_<type>._tcp` with
[bonjour-service](https://www.npmjs.com/package/bonjour-service) and returns `{ stop }`. Put the dial URL in `txt`.
bonjour-service answers with every interface's address, so the device should dial the URL in `txt`, not a resolved
address. A device that finds the wrong computer fails link's handshake, because the host key is pinned.

### Browse (React Native)

Under React Native (the package's `react-native` export condition), `@byokit/reach` also browses the LAN so an app
can find services without typing an address:

```ts
import { browse, scan } from '@byokit/reach';

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
values only). The pinned `react-native-zeroconf` dependency (`0.14.0`) is supplied by reach, not the app.
One native browser runs one browse at a time. Starting another `browse` or `scan` preempts the current handle,
including when both request the same type: it receives one `stopped` event with `{ reason: 'preempted' }`, loses its
known services, and does not resume. A preempted `scan` rejects; callers needing continuous discovery must start
a fresh browse after their other scan finishes. Resolved events must identify the active service type in `fullName`;
removals apply only to names that browse has found. Native errors are ignored for one second after preemption.
The native module supplies no scan ID: an untyped late removal for a name reused by the new browse, or an error
after that second, can still be attributed to the new scan; a real error during the quiet second is also ignored.
Node and web builds resolve the main entry and never import the native module. Expo apps must rebuild their native
binary after adding reach. Android emulator note: mDNS multicast does not work on the emulator — test discovery
on a real device.

## Tests

`test/reach.test.ts` ports muxr's `checkTailscaleIngress` and uses a fake tailscale CLI that logs every call. The real
binary never runs, and no packet goes out: mDNS advertise is tested with a fake publisher, and the React Native
browse API with a fake zeroconf module.
