# @byokit/link: threat model and review checklist

Version 0.3.0. Muxr parity is tracked separately.

## What it protects

A home computer (the **host**) holds AI sign-ins and other credentials. Phones, browsers and other computers
(**devices**) pair with it once and then ask it to do things. The link must make sure that:

1. only a device a person at the host approved can make requests;
2. nobody on the path (home network, tailnet, relay, public Wi-Fi) can read or change the traffic, replay it, or
   pretend to be either end;
3. a device gets answers, never the host's credentials;
4. removing a device takes effect immediately, including on its open connections;
5. a device that is view-only cannot make changes.

## Design in one screen

| Piece | Choice |
|---|---|
| Handshake, every connection | `Noise_IK_25519_ChaChaPoly_BLAKE2b`, prologue `byokit-link-v1`. The device knows the host's static key (from the QR, then its grant); its own static key travels encrypted in message 1. Fresh ephemerals per connection: forward secrecy. |
| Handshake, typed code | `Noise_XXpsk0_25519_ChaChaPoly_BLAKE2b`, PSK = BLAKE2b-256(`byokit-link-code-v1` ‖ code). Only a holder of the code can finish; each side learns the other's static key. |
| Library | Handshakes: `noise-handshake` 4.2.0 (Holepunch, Apache-2.0) over libsodium: `sodium-native` in Node, `sodium-javascript` 0.8.0 in browsers and React Native. Frames after the handshake: ChaCha20-Poly1305 from `@noble/ciphers` 2.4.0 (Paul Miller, MIT, audited, no dependencies) on every platform, because sodium-javascript's ChaCha20 was slower in a Hermes CLI benchmark on a desktop CPU (`bench/hermes.sh`); this is not a phone measurement. Same cipher, same Noise nonce, byte-identical frames: no wire change. Pinned exactly. No crypto of our own. |
| Conformance | `noise-handshake` is checked against the cacophony vectors for IK, XX and NNpsk0, which together cover every token of both handshakes; `@noble/ciphers` against the RFC 8439 AEAD vectors; and the transport against noise-handshake's own CipherState (sodium-native) and sodium-javascript, sealing and opening both ways (`test/channel.test.ts`). |
| Frames | One Noise transport message per WebSocket frame. JSON control messages use base64 text; see Streams below for data frames. Per-direction CipherStates; the implicit nonce counter rejects any replayed, dropped, reordered or reflected frame, and any bad frame closes the socket. Messages over 60 KB are chunked; a reassembled message over 16 MB closes the socket. |
| QR / pairing link | `byokit-link:1:<base64url JSON>`: `{v, host (X25519 public key), name, urls, ticket (128 bits), expires}`. As a link, it rides after `#`, which browsers never send to a server. |
| Typed code | 12 characters from a 31-character unambiguous alphabet (about 59 bits), `XXXX-XXXX-XXXX`. |
| Pairing rules | Tickets and codes are single use (burned at first presentation, even when expired or refused), live 5 minutes through grant creation, and 5 wrong tries withdraw every open ticket and code. Nothing is stored until the person at the host approves; both screens show the same **two confirmation words**, derived from the handshake hash. Optional device cap. |
| Grants | Held by the host: `{id, key, name, role: control or view, created, lastSeen, meta}`. Durable until revoked (muxr decision 0001). Every handshake checks the device key against the list; every request re-checks it. View-only devices may only make the requests the app's `canView` allows (default: none). |
| Revoke | Deletes the grant, sends a sealed `revoked` to its live sockets, then closes them. No key rotation is needed: there are no shared keys. |
| Refusals | A host that can read the device's handshake answers refusals (`not-paired`, `expired`, `declined`, `full`) inside the channel, so the device can trust them (e.g. forget its grant). Anything unauthenticated (a plaintext close) only changes what the device *says*, never what it deletes. |
| Requests | `{t:'req', id, key, session, ack, op, args}`. The device sends its highest contiguous received reply id on each request and reconnect authentication. The host retains replies until acknowledged across reconnects; a fresh app session clears abandoned replies because they can no longer be retried. At 1000 unacknowledged replies it refuses new requests with `busy`, without evicting answers. The cache is in memory. |
| Streams | Opened by the device (`{t:'open', s, op, args, credit}`), answered `{t:'opened', s, credit}` or `{t:'end', s, error}`; then `{t:'credit', s, n}` and `{t:'end', s, error?}` either way, and the bytes as a binary inner message (frame flag 2/3: 4-byte stream id, then raw bytes), all sealed in the same channel and nonce sequence. On a direct socket the host offers `binary: 1` in `ready` and stream frames then go as binary WebSocket messages (the same Noise message, not base64); through a relay they stay base64 text. A binary message before the handshake closes the socket. Offered only by a host that says `streams: 1` in `ready`, so an older peer never gets one. Opening re-checks the grant and view-only (`canView`) before sending `opened` and credit, then runs the app's `stream` handler with the grant; handler failures end an already-opened stream (only `PublicLinkError` exposes its message). A side that sends past the window it was granted (256 KB per stream, at most 64 streams per connection) is cut off. Streams end with their socket and on revoke. |
| Relay | Routes by URL (`<relay>/link/v1/<host id>`, host id = BLAKE2b-128(`byokit-link-host-id-v1` ‖ host key)) and, host-side, by a `{c, f}` / `{c, end}` wrapper. Frames pass through byte for byte. The separate [`@byokit/relay`](../relay) package supplies the relay server; its push-content exception and store boundaries are in [its security guide](../relay/SECURITY.md). |

## Adversaries and what stops them

| Adversary | Can | Cannot, because |
|---|---|---|
| **Passive network observer** (LAN, tailnet, relay operator) | See that a device talks to a host, when, how much; the host id; for typed codes, message 1 | Read plaintext payloads: IK hides the device's static key; everything after is AEAD. A captured typed-code handshake permits offline guessing even after expiry, but the code has about 59 bits of entropy. |
| **Active network attacker** (ARP/DNS spoofing, malicious relay) | Drop, delay, reorder traffic; close sockets; forge plaintext closes | Impersonate the host (needs the host's static secret; the device pins the key from the QR/grant). Impersonate a device (needs its static secret). Replay or splice frames (nonces). Make a device forget its grant (only sealed refusals do that). Turn a stolen QR ticket into a grant without host-side approval: the QR also contains the host's public key, so its secrecy is not a defense. |
| **Someone who sees or photographs the QR / code** | Race the real device to pair in the 5 minutes | Get in unnoticed: the person at the host must approve, sees the device name and the two words, and a later attempt with the same ticket or code is refused. |
| **A lost or stolen device** | Everything its grant allows, until revoked | Anything after revoke, which is immediate. It never held the host's credentials. |
| **A paired view-only device** | The requests `canView` allows | Mutating requests: refused by the host before the app's handler sees them. |
| **A malicious relay** | Deny service; learn metadata above | Read, change or inject traffic; pair itself (tickets and codes are sealed or PSK-bound end to end). An impostor host registration only causes denial of service: devices' handshakes fail. |

## Known limits

1. **Typed-code offline guessing.** XXpsk0 puts the PSK in message 1, so an observer can test guesses against it
   offline even after the code expires. The 59-bit search space is the defense; expiry limits pairing, not
   captured-handshake guessing. A shorter code would weaken it. PSK at message 3 (XXpsk3) would limit the oracle to
   an active attacker, but `noise-handshake` does not implement it. **Upgrade path: a PAKE
   (CPace) for typed codes**, which also makes shorter codes safe.
2. **The two words are 16 bits.** They confirm "this is the device in my hand", not the channel: an active attacker
   who already holds a live code could grind 16 bits. The host key in the QR (IK) and the code (PSK) carry the real
   authentication.
3. **32-bit nonce counter.** For compatibility with `noise-handshake`'s 32-bit counter, the channel refuses to send
   or receive past 2³² − 1 frames per direction (the socket must reconnect); it never wraps.
4. **Library activity.** `noise-handshake` (pushed 2025-12) and `sodium-javascript` (2022) are low-activity; the
   Noise pattern set is frozen and the vectors pin behaviour. If the handshake implementation is abandoned, a
   reviewed replacement must preserve the authenticated protocol and existing wire format.
5. **Denial of service.** New handshakes are limited before any key work: 300 a minute in all and 30 per `peer`
   (the app passes the source address to `accept`; relayed connections count only toward the total). That caps CPU,
   not a flood of sockets: apps still expose the link only on loopback/tailnet/LAN by default, or behind a relay that
   limits connections.
6. **Idempotency survives reconnects within one app session, and host restarts only with an `answers` store.**
   Without one, the answer cache is in memory. A store that fails to read refuses the request rather than risk running
   it twice; `answers.put` happens after the handler, so a host crash between its effect and the put can repeat the
   request unless the handler records `req.key` in the same transaction as its effect. A failed put is reported and
   the answer is still sent. A request can also carry `notValidAfter` so a stale retry is never started. A fresh authenticated app session discards the previous session's abandoned replies. A device with 1000 unacknowledged replies receives `busy` for new requests until it acknowledges earlier replies; no reply is evicted during the same session.
7. **Key storage is the app's job.** Host key: OS keychain (Electron `safeStorage`) or a 0600 file. React Native:
   `expo-secure-store`. Browser: IndexedDB, wrapped by a non-extractable WebCrypto AES-GCM key (muxr decision 0003);
   a live XSS can still use an unlocked key, so browsers should default to view-only. Android native: X25519 wrapped
   by a Keystore key (not hardware-bound; plan decision D3).
8. **Grant expiry is opt-in.** Grants last until revoked unless made with a `lifetime` (muxr decision 0001; short
   browser grants per decision 0003). An expired grant is removed like a revoke: refused at `auth`, on the next
   request, and on a timer for open sockets. Expiry uses the host's clock (`now`, which exists for tests); an app
   that freezes it keeps codes and grants alive.
10. **Rekey keeps two keys valid for a moment.** After `rekey`, the host accepts the old key and the staged new one
   until the device first connects with the new one; from then on only the new key works. A device that loses the
   staged key before that point keeps using the old key.
11. **`unpair` needs the host.** Offline, or against a 0.1 host, a device only forgets locally and the host keeps
   listing it until someone removes it there.
9. **Metadata.** The relay sees the host id, timing, sizes, device IP addresses and whether a first message is a
   typed-code attempt (`code:` prefix).

## Review checklist

- [ ] The pinned versions of `noise-handshake`, `@noble/ciphers`, `sodium-universal`, `sodium-native`, `sodium-javascript`, `b4a` are
      the ones reviewed; `package-lock.json` integrity hashes match npm.
- [ ] `test/channel.test.ts` vectors pass: `noise-handshake` matches cacophony for IK, XX, NNpsk0.
- [ ] `Handshake` uses IK with the remote static key pre-set on the initiator, and XXpsk0 only with a PSK; the
      prologue is `byokit-link-v1`.
- [ ] The host sends nothing but a plaintext close before a handshake it can verify; no request is served before
      `ready`.
- [ ] Tickets and codes: 128-bit and 59-bit, single use (deleted on first presentation), 5-minute expiry checked at
      presentation and before persisting the grant, 5 wrong tries withdraw all open tickets and codes.
- [ ] Nothing is stored before `confirm` returns true; `confirm` failing or timing out means no.
- [ ] Every connection's device key is checked against the grants at `auth`; every request re-checks the grant;
      `revoke` removes the grant before closing sockets.
- [ ] View-only is enforced in the host before the app handler, and defaults closed. Only an explicit `PublicLinkError` discloses its chosen message; other handler failures are logged on the host and return plain `failed`.
- [ ] A device forgets its grant only on a sealed `revoked` or sealed `not-paired`.
- [ ] Names shown to people are stripped of control and direction-flipping characters and capped at 60.
- [ ] `parseOffer` accepts only `ws:`/`wss:` addresses without credentials, at most 8, a 32-byte key and 16-byte
      ticket.
- [ ] The channel refuses frames past 2³² − 1 and messages over 16 MB.
- [ ] Stream opens re-check the grant and view-only before the app's `stream` handler; data past a stream's window,
      or stream data that isn't a binary inner message, drops the socket; streams end on disconnect and revoke.
- [ ] The link relay test shows no plaintext, device name, request or device id in routed link frames (push metadata has a separate [boundary](../relay/SECURITY.md)).
- [ ] The browser bundle has no Node built-ins, and the headless-browser test pairs and makes requests.
- [ ] Grant changes (pair, enrol, revoke, expiry, unpair, rekey, last seen) all go through one serialized
      transition that saves before memory changes, then closes or updates that device's live sockets.
- [ ] `allow` (or, without it, role plus `canView`) runs before `handle`; a throwing policy refuses.
- [ ] Expired grants are refused at `auth` and on requests, and live sockets close when access runs out.
- [ ] Per-kind caps and `maxDevices` are checked inside the grant transition, so concurrent approvals can't exceed them.
- [ ] A rekey's new key is stored on the device before the host hears it; the host promotes it only when the device
      authenticates with it.
- [ ] The handshake limiter runs before any Diffie-Hellman.
- [ ] Nothing in the main entry reads or writes files, environment variables or other programs.
      `@byokit/link/node` `hostKeyFile(path)` touches only that path: 0600 in 0700, atomic, never replaces a file it
      can't read, refuses symlinks.
