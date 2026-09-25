# @byokit/link: threat model and review checklist

Status: v0.1, **held for the owner's security review**. Not published.

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
| Library | `noise-handshake` 4.2.0 (Holepunch, Apache-2.0) over libsodium: `sodium-native` in Node, `sodium-javascript` 0.8.0 in browsers and React Native. Pinned exactly. No crypto of our own. |
| Conformance | `noise-handshake` is checked against the cacophony vectors for IK, XX and NNpsk0, which together cover every token of both handshakes (`test/channel.test.ts`). |
| Frames | One Noise transport message per WebSocket text frame, base64. Per-direction CipherStates; the implicit nonce counter rejects any replayed, dropped, reordered or reflected frame, and any bad frame closes the socket. Messages over 60 KB are chunked; a reassembled message over 16 MB closes the socket. |
| QR / pairing link | `byokit-link:1:<base64url JSON>`: `{v, host (X25519 public key), name, urls, ticket (128 bits), expires}`. As a link, it rides after `#`, which browsers never send to a server. |
| Typed code | 12 characters from a 31-character unambiguous alphabet (about 59 bits), `XXXX-XXXX-XXXX`. |
| Pairing rules | Tickets and codes are single use (burned at first presentation, even when expired or refused), live 5 minutes, and 5 wrong tries withdraw every open code. Nothing is stored until the person at the host approves; both screens show the same **two confirmation words**, derived from the handshake hash. Optional device cap. |
| Grants | Held by the host: `{id, key, name, role: control or view, created, lastSeen, meta}`. Durable until revoked (muxr decision 0001). Every handshake checks the device key against the list; every request re-checks it. View-only devices may only make the requests the app's `canView` allows (default: none). |
| Revoke | Deletes the grant, sends a sealed `revoked` to its live sockets, then closes them. No key rotation is needed: there are no shared keys. |
| Refusals | A host that can read the device's handshake answers refusals (`not-paired`, `expired`, `declined`, `full`) inside the channel, so the device can trust them (e.g. forget its grant). Anything unauthenticated (a plaintext close) only changes what the device *says*, never what it deletes. |
| Requests | `{t:'req', id, key, op, args}`. The key makes a retried request run once, including after a reconnect. Answers are cached per device (last 200) in memory. |
| Relay | Routes by URL (`<relay>/link/v1/<host id>`, host id = BLAKE2b-128 of the host key) and, host-side, by a `{c, f}` / `{c, end}` wrapper. Frames pass through byte for byte. The relay is not part of v0.1. |

## Adversaries and what stops them

| Adversary | Can | Cannot, because |
|---|---|---|
| **Passive network observer** (LAN, tailnet, relay operator) | See that a device talks to a host, when, how much; the host id; for typed codes, message 1 | Read anything: IK hides the device's static key; everything after is AEAD. Offline-guess a typed code within its 5 minutes: 59 bits, each guess a full Noise message-1 check. |
| **Active network attacker** (ARP/DNS spoofing, malicious relay) | Drop, delay, reorder traffic; close sockets; forge plaintext closes | Impersonate the host (needs the host's static secret; the device pins the key from the QR/grant). Impersonate a device (needs its static secret). Replay or splice frames (nonces). Make a device forget its grant (only sealed refusals do that). Use a stolen QR ticket without the host key, or redirect pairing: the ticket is only readable by the real host. |
| **Someone who sees or photographs the QR / code** | Race the real device to pair in the 5 minutes | Get in unnoticed: the person at the host must approve, sees the device name and the two words, and the real device fails with "code already used". |
| **A lost or stolen device** | Everything its grant allows, until revoked | Anything after revoke, which is immediate. It never held the host's credentials. |
| **A paired view-only device** | The requests `canView` allows | Mutating requests: refused by the host before the app's handler sees them. |
| **A malicious relay** | Deny service; learn metadata above | Read, change or inject traffic; pair itself (tickets and codes are sealed or PSK-bound end to end). An impostor host registration only causes denial of service: devices' handshakes fail. |

## Known limits (decide in review)

1. **Typed-code offline guessing.** XXpsk0 puts the PSK in message 1, so an observer can test guesses against it
   offline. 59 bits for 5 minutes is out of reach; a longer window or shorter code is not. PSK at message 3 (XXpsk3)
   would limit the oracle to an active attacker, but `noise-handshake` does not implement it. **Upgrade path: a PAKE
   (CPace) for typed codes**, which also makes shorter codes safe.
2. **The two words are 16 bits.** They confirm "this is the device in my hand", not the channel: an active attacker
   who already holds a live code could grind 16 bits. The host key in the QR (IK) and the code (PSK) carry the real
   authentication.
3. **32-bit nonce counter.** `noise-handshake` writes the counter into 4 bytes. The channel refuses to send or
   receive past 2³² − 1 frames per direction (the socket must reconnect); it never wraps.
4. **Library activity.** `noise-handshake` (pushed 2025-12) and `sodium-javascript` (2022) are low-activity; the
   Noise pattern set is frozen and the vectors pin behaviour. Fallback if either is abandoned: libsodium
   `crypto_kx` + `secretstream`, still reviewed crypto.
5. **Denial of service.** No rate limit on handshakes (each costs the host a few X25519 operations). Apps expose the
   socket only on loopback/tailnet/LAN by default (Crewhouse does) or behind a relay that limits.
6. **Idempotency survives reconnects, not host restarts.** The answer cache is in memory.
7. **Key storage is the app's job.** Host key: OS keychain (Electron `safeStorage`) or a 0600 file. React Native:
   `expo-secure-store`. Browser: IndexedDB, wrapped by a non-extractable WebCrypto AES-GCM key (muxr decision 0003);
   a live XSS can still use an unlocked key, so browsers should default to view-only. Android native: X25519 wrapped
   by a Keystore key (not hardware-bound; plan decision D3).
8. **No per-grant expiry.** Grants last until revoked, by design (muxr decision 0001). Short-lived browser grants
   (muxr decision 0003: eight hours) would be an app-level `meta.expires` checked in `canView`/`handle`, or a small
   addition here.
9. **Metadata.** The relay sees the host id, timing, sizes, device IP addresses and whether a first message is a
   typed-code attempt (`code:` prefix).

## Review checklist

- [ ] The pinned versions of `noise-handshake`, `sodium-universal`, `sodium-native`, `sodium-javascript`, `b4a` are
      the ones reviewed; `package-lock.json` integrity hashes match npm.
- [ ] `test/channel.test.ts` vectors pass: `noise-handshake` matches cacophony for IK, XX, NNpsk0.
- [ ] `Handshake` uses IK with the remote static key pre-set on the initiator, and XXpsk0 only with a PSK; the
      prologue is `byokit-link-v1`.
- [ ] The host sends nothing but a plaintext close before a handshake it can verify; no request is served before
      `ready`.
- [ ] Tickets and codes: 128-bit and 59-bit, single use (deleted on first presentation), 5-minute expiry checked at
      use, 5 wrong tries withdraw all codes.
- [ ] Nothing is stored before `confirm` returns true; `confirm` failing or timing out means no.
- [ ] Every connection's device key is checked against the grants at `auth`; every request re-checks the grant;
      `revoke` removes the grant before closing sockets.
- [ ] View-only is enforced in the host before the app handler, and defaults closed.
- [ ] A device forgets its grant only on a sealed `revoked` or sealed `not-paired`.
- [ ] Names shown to people are stripped of control and direction-flipping characters and capped at 60.
- [ ] `parseOffer` accepts only `ws:`/`wss:` addresses without credentials, at most 8, a 32-byte key and 16-byte
      ticket.
- [ ] The channel refuses frames past 2³² − 1 and messages over 16 MB.
- [ ] The relay test shows no plaintext, device name, request or device id on the relay's wire.
- [ ] The browser bundle has no Node built-ins, and the headless-browser test pairs and makes requests.
- [ ] Nothing in the package reads or writes files, environment variables or other programs.
