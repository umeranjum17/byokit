# @byokit/pair: threat model and review checklist

Muxr parity is tracked separately.

## What it protects

A home computer (the **host**) holds AI sign-ins and other credentials. Phones, browsers and other computers
(**devices**) pair with it once and then ask it to do things. The link must make sure that:

1. only a device a person at the host approved can make requests;
2. nobody on the path (home network, tailnet, relay, public Wi-Fi) can read or change the traffic, replay it, or
   pretend to be either end;
3. a device gets answers, never the host's credentials;
4. removing a device takes effect immediately, including on its open connections;
5. a device can make only requests the host app's policy permits.

## Design in one screen

| Piece | Choice |
|---|---|
| Handshake, every connection | `Noise_IK_25519_ChaChaPoly_BLAKE2b`, prologue `byokit-link-v1`. The device knows the host's static key (from the QR, then its grant); its own static key travels encrypted in message 1. Fresh ephemerals per connection: forward secrecy. |
| Handshake, typed code | `Noise_XXpsk0_25519_ChaChaPoly_BLAKE2b`, PSK = BLAKE2b-256(`byokit-link-code-v1` ‖ code). Only a holder of the code can finish; each side learns the other's static key. |
| Machine-bound typed code | `Host.shortCode()` prepends `K1` to the existing 59.45-bit secret and appends BLAKE2b-128(`byokit-link-short-key-v1` ‖ host public key) in hex. The device verifies that public commitment after Noise message 2, before revealing its identity in message 3. Untrusted address lookup cannot replace the pinned machine key, even with the secret. Full [design and example](README.md#typed-pairing-on-a-small-terminal). |
| Library | Handshakes: `noise-handshake` 4.2.0 (Holepunch, Apache-2.0) over libsodium: `sodium-native` in Node, `sodium-javascript` 0.8.0 in browsers and React Native. Frames after the handshake: ChaCha20-Poly1305 from `@noble/ciphers` 2.4.0 (Paul Miller, MIT, audited, no dependencies) on every platform, because sodium-javascript's ChaCha20 was slower in a Hermes CLI benchmark on a desktop CPU (`bench/hermes.sh`); this is not a phone measurement. Same cipher, same Noise nonce, byte-identical frames: no wire change. Pinned exactly. No crypto of our own. |
| Conformance | `noise-handshake` is checked against the cacophony vectors for IK, XX and NNpsk0, which together cover every token of both handshakes; `@noble/ciphers` against the RFC 8439 AEAD vectors; and the transport against noise-handshake's own CipherState (sodium-native) and sodium-javascript, sealing and opening both ways (`test/channel.test.ts`). |
| Frames | One Noise transport message per WebSocket frame. JSON control messages use base64 text; see Streams below for data frames. Per-direction CipherStates; the implicit nonce counter rejects any replayed, dropped, reordered or reflected frame, and any bad frame closes the socket. Messages over 60 KB are chunked; a reassembled message over 16 MB closes the socket. |
| QR / pairing link | `byokit-link:1:<base64url JSON>`: `{v, host (X25519 public key), name, urls, ticket (128 bits), expires, role?, lifetime?}`. The optional role and access lifetime let the device show the terms; older parsers ignore them. As a link, it rides after `#`, which browsers never send to a server. |
| Offline offer envelope | Versioned base32 of the complete validated offer plus a 32-bit FNV-1a transcription checksum. Case, whitespace, dashes and O/0, I/L/1 aliases are normalized; noncanonical padding is refused. The checksum is not authentication. The same QR ticket, host key, expiry and approval rules apply; relay addresses and grant terms are preserved. |
| Typed code | 12 characters from a 31-character unambiguous alphabet (about 59 bits), `XXXX-XXXX-XXXX`. |
| Pairing rules | Tickets and codes are single use (burned at first presentation, even when expired or refused), live 5 minutes through grant creation, and 5 wrong tries withdraw every open ticket and code. Nothing is stored until the person at the host approves; both screens show the same **two confirmation words**, derived from the handshake hash. Optional device cap. An approval holds after the device's socket dropped only when the device said, inside the handshake (`pending: 1` in its sealed `pair` request or typed-code message 3), that it kept a pending grant; the grant names only the device key that handshake authenticated. Any other device that leaves gets no grant, so no slot is held by a key nobody has. A compact QR carries no host key; the device keeps the key the code handshake authenticated (after message 2, before its identity goes out in message 3) as its pending grant's pin, so a resumed link is pinned exactly as from a version 1 QR. |
| Grants | Held by the host with a device key and role; optional `kind`, `expires`, `nextKey` and `meta` support caps, expiry, rekey and app policy. Every handshake and request checks the grant. `allow` decides access when supplied; otherwise control is allowed and view-only uses `canView` (default: none). |
| Presence and reload | Presence counts authenticated live sockets per grant and fires only on first/last. Store notifications trigger a serialized `Host.reload` with no write-back; removed/key-changed/role-changed grants close live sockets, and changed expiry reschedules access. A failed read preserves the last known authority and reports the failure: notifications are eventual, so an app needing instantaneous external-authority checks must enforce them in `allow`. The Node file backend uses a cooperating-writer lock and rejects stale snapshots; it polls only the app's chosen path and stops when the host closes. |
| Ready metadata | Only the opt-in `deviceMeta(grant)` projection is sent to the device, inside the sealed `ready`. Host grant metadata is private by default. The app must not project credentials. |
| Device collections | Secure-store grants have a private index and serialized per-runtime writes; interrupted saves leave filterable missing entries rather than orphaned grants. IndexedDB collections enumerate sealed entries and preserve per-entry non-extractable keys and clear/save tombstones. This is one device's computers, not a hosted multi-tenant credential service. |
| Delegated pairing | An authenticated inviter asks `handle` for a host-issued, constrained offer; `confirm` validates host-chosen scope and the inviter's current authority before approving it. The existing single-use/five-minute/approval rules apply. Apps enforce scope in `allow`; no offline or long-lived bearer invitation is added. Paired peers are independent grants, so cascading revoke is an app policy. |
| Revoke | Deletes the grant, sends a sealed `revoked` to its live sockets, then closes them. Optional `onGrantRemoved` runs after access is invalidated, including offline removal, expiry and authority changes; removal awaits its privacy cleanup and a failure never restores access. Ordinary connection drops do not call it. No key rotation is needed: there are no shared keys. |
| Refusals | A host that can read the device's handshake answers refusals (`not-paired`, `expired`, `ended`, `declined`, `full`) inside the channel, so the device can trust them (e.g. forget its grant). Anything unauthenticated (a plaintext close) only changes what the device *says*, never what it deletes. |
| Requests | `{t:'req', id, key, session, ack, op, args, notValidAfter?}`. The device sends its highest contiguous received reply id on each request and reconnect authentication. The host retains replies until acknowledged across reconnects; a fresh app session clears abandoned replies. At 1000 unacknowledged replies it refuses new requests with `busy`, without evicting answers. The cache is in memory unless the app supplies an `answers` store. |
| Streams | Opened by the device (`{t:'open', s, op, args, credit}`), answered `{t:'opened', s, credit}` or `{t:'end', s, error}`; then `{t:'credit', s, n}` and `{t:'end', s, error?}` either way, and the bytes as a binary inner message (frame flag 2/3: 4-byte stream id, then raw bytes), all sealed in the same channel and nonce sequence. On a direct socket the host offers `binary: 1` in `ready` and stream frames then go as binary WebSocket messages (the same Noise message, not base64); through a relay they stay base64 text. A binary message before the handshake closes the socket. Offered only by a host that says `streams: 1` in `ready`, so an older peer never gets one. Opening re-checks the grant and policy (`allow`, or `canView` for view-only when `allow` is absent) before sending `opened` and credit, then runs the app's `stream` handler with the grant; handler failures end an already-opened stream (only `PublicLinkError` exposes its message). A side that sends past the window it was granted (256 KB per stream, at most 64 streams per connection) is cut off. Streams end with their socket and on revoke. |
| Relay | Routes by URL (`<relay>/link/v1/<host id>`, host id = BLAKE2b-128(`byokit-link-host-id-v1` ‖ host key)) and, host-side, by a `{c, f}` / `{c, end}` wrapper. Frames pass through byte for byte. The separate [`@byokit/relay`](../relay) package supplies the relay server; its push-content exception and store boundaries are in [its security guide](../relay/SECURITY.md). |

## Adversaries and what stops them

| Adversary | Can | Cannot, because |
|---|---|---|
| **Passive network observer** (LAN, tailnet, relay operator) | See that a device talks to a host, when, how much; the host id; for typed codes, message 1 | Read plaintext payloads: IK hides the device's static key; everything after is AEAD. A captured typed-code handshake permits offline guessing even after expiry, but the code has about 59 bits of entropy. |
| **Active network attacker** (ARP/DNS spoofing, malicious relay) | Drop, delay, reorder traffic; close sockets; forge plaintext closes | Impersonate the host (needs the host's static secret; the device pins the key from the QR/grant). Impersonate a device (needs its static secret). Replay or splice frames (nonces). Make a device forget its grant (only sealed refusals do that). Turn a stolen QR ticket into a grant without host-side approval: the QR also contains the host's public key, so its secrecy is not a defense. |
| **Someone who sees or photographs the QR / code** | Race the real device to pair in the 5 minutes | Get in unnoticed: the person at the host must approve, sees the device name and the two words, and a later attempt with the same ticket or code is refused. |
| **A lost or stolen device** | Everything its grant allows, until revoked or expired | Anything after revoke or expiry. It never held the host's credentials. |
| **A paired view-only device** | Requests permitted by the app's `allow`, or by `canView` when `allow` is absent | Requests denied by that policy: refused by the host before the app's handler sees them. |
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
   it twice; stored answers are bound to the original operation and JSON-encoded arguments, and a mismatched or
   malformed record is refused without running the handler. `answers.put` happens after the handler, so a host crash
   between its effect and the put can repeat the request unless the handler records `req.key` in the same transaction
   as its effect. A failed put is reported and the answer is still sent. A request can also carry `notValidAfter` so a
   stale retry is never started. A fresh authenticated app session discards the previous session's abandoned replies.
   A device with 1000 unacknowledged replies receives `busy` for new requests until it acknowledges earlier replies;
   no reply is evicted during the same session.
7. **Key storage is the app's job.** Host key: OS keychain (Electron `safeStorage`) or a 0600 file. React Native:
   `expo-secure-store`. Browser: IndexedDB, wrapped by a non-extractable WebCrypto AES-GCM key (muxr decision 0003);
   a live XSS can still use an unlocked key, so browsers should default to view-only. Android native: X25519 wrapped
   by a Keystore key (not hardware-bound; plan decision D3).
8. **Grant expiry is opt-in.** Grants last until revoked unless made with a `lifetime` (muxr decision 0001; short
   browser grants per decision 0003). An expired grant is removed like a revoke: refused at `auth`, on the next
   request, and on a timer for open sockets. Expiry uses the host's clock (`now`, which exists for tests); an app
   that freezes it keeps codes and grants alive.
9. **Rekey keeps two keys valid for a moment.** After `rekey`, the host accepts the old key and the staged new one
   until the device first connects with the new one; from then on only the new key works. A device that loses the
   staged key before that point keeps using the old key.
10. **`unpair` needs the host.** Offline, against a 0.1 host, or when saving removal fails, the device keeps its
   grant and reports failure. It forgets locally only after the host confirms removal.
11. **Policy decisions are point-in-time.** `allow` decides when asked; work already started is not rolled back.
   Replace a grant's metadata with `host.setMeta(id, newMeta)` or revoke it to withdraw access. Do not mutate
   `meta` in place: the post-policy identity check requires a replacement grant object.
12. **Metadata.** The relay sees the host id, timing, sizes, device IP addresses and whether a first message is a
   typed-code attempt (`code:` prefix).

## Review checklist

- [x] The pinned versions of `noise-handshake`, `@noble/ciphers`, `sodium-universal`, `sodium-native`, `sodium-javascript`, `b4a` are
      the ones reviewed; `package-lock.json` integrity hashes match npm.
- [x] `test/channel.test.ts` vectors pass: `noise-handshake` matches cacophony for IK, XX, NNpsk0.
- [x] `Handshake` uses IK with the remote static key pre-set on the initiator, and XXpsk0 only with a PSK; the
      prologue is `byokit-link-v1`.
- [x] The host sends nothing but a plaintext close before a handshake it can verify; no request is served before
      `ready`.
- [x] Tickets and codes: 128-bit and 59-bit, single use (deleted on first presentation), 5-minute expiry checked at
      presentation and before persisting the grant, 5 wrong tries withdraw all open tickets and codes.
- [x] Nothing is stored before `confirm` returns true; `confirm` failing or timing out means no.
- [x] Bound typed codes check the 128-bit machine-key commitment before message 3, displaying words or receiving a grant; malformed codes never downgrade to legacy pairing. Relay lookup receives only its separate routing code.
- [x] Every connection's device key is checked against the grants at `auth`; every request re-checks the grant;
      `revoke` removes the grant before closing sockets.
- [x] Host policy is enforced before the app handler; without `allow`, view-only defaults closed. Only an explicit `PublicLinkError` discloses its chosen message; other handler failures are logged on the host and return plain `failed`.
- [x] A device forgets its grant only on a sealed `revoked`, `ended` or `not-paired` (or when a pending pairing expires).
- [x] Names shown to people are stripped of control and direction-flipping characters and capped at 60.
- [x] `parseV1Offer` accepts only `ws:`/`wss:` addresses without credentials, at most 8, a 32-byte key and 16-byte
      ticket.
- [x] Offline offer decoding checks the checksum, version, canonical padding, bounds and all `parseV1Offer` rules, including expiry; inspecting with `now = 0` never renews a ticket. Legacy compact offers are accepted only on the migration read path, with their original pinned key, ticket, role and second-resolution expiry; they cannot change new encodings.
- [x] The channel refuses frames past 2³² − 1 and messages over 16 MB.
- [x] Stream opens re-check the grant and policy before the app's `stream` handler; data past a stream's window,
      or stream data that isn't a binary inner message, drops the socket; streams end on disconnect and revoke.
- [x] The link relay test shows no plaintext, device name, request or device id in routed link frames (push metadata has a separate [boundary](../relay/SECURITY.md)).
- [x] The browser bundle has no Node built-ins, and the headless-browser test pairs and makes requests.
- [x] Grant changes (pair, enrol, revoke, expiry, unpair, rekey, last seen) all go through one serialized
      transition that saves before memory changes; expiry closes live sockets even if the removal save fails.
- [x] `allow` (or, without it, role plus `canView`) runs before `handle`; a throwing policy refuses.
- [x] Expired grants are refused at `auth` and on requests, and live sockets close when access runs out.
- [x] Per-kind caps and `maxDevices` are checked inside the grant transition, so concurrent approvals can't exceed them.
- [x] A rekey's new key is stored on the device before the host hears it; the host promotes it only when the device
      authenticates with it.
- [x] The handshake limiter runs before any Diffie-Hellman.
- [x] Nothing in the main entry reads or writes files, environment variables or other programs.
      `@byokit/pair/node` `hostKeyFile(path)` touches only that path: 0600 in 0700, atomic, never replaces a file it
      can't read, refuses symlinks.

- [ ] Presence fires once on first/last sockets, including failed/successful unpair, reload, expiry and close.
- [ ] A grant reload never saves its snapshot back; failed reads preserve memory; Node stale writes reject.
- [ ] Ready metadata is opt-in, sealed, refreshed on reconnect, and never implicitly includes Grant.meta.
- [ ] Device collection removal preserves neighbours, excludes tombstones and retains browser key protection.
- [ ] Delegated invitation scope is host-chosen, redemption checks the current inviter, and peer requests remain policy-checked.

## Recorded review — 2026-09-30

This implementation review covers all 23 checklist rows in order on the branch based on `9ee1846`.
It is a source and executable protocol review, not an independent cryptographic audit. Dependency
versions did not change. `npm ci` reported zero vulnerabilities; for each of the six dependencies
below, `npm view <name>@<version> dist.integrity` matched `package-lock.json`:
`noise-handshake@4.2.0`, `@noble/ciphers@2.4.0`, `sodium-universal@5.0.1`,
`sodium-native@5.1.0`, `sodium-javascript@0.8.0`, `b4a@1.9.0`.

The checked boxes mean the implementation and named evidence passed this review. They do not
remove the known limits above. Run the evidence offline after `npm ci` and `npm run build`:

```sh
TMPDIR=/tmp sh scripts/test.sh 'packages/pair/test/*.test.ts' 'packages/relay/test/*.test.ts'
```

| Row | Result and evidence (paths relative to this package) |
|---|---|
| 1 | PASS: exact pins in `package.json`; registry integrity comparison above; installed lock via `npm ci`. |
| 2 | PASS: `test/channel.test.ts`, cacophony IK/XX/NNpsk0, RFC 8439 and both sodium implementations. |
| 3 | PASS: `src/channel.ts` constructor pins the remote IK key and prologue; typed-code right/wrong PSK test in `test/channel.test.ts`. |
| 4 | PASS: `src/host.ts` connection state gates auth/pair before requests; `test/link.test.ts` security-review pre-ready request closes with no handler or grant. Before verification only a close is sent; after a verified IK message only the handshake answer precedes auth. |
| 5 | PASS: `src/pairing.ts` rejection-sampled alphabet, `src/host.ts` ticket randomness/take/wrong; `test/link.test.ts` single-use QR/code, five wrong tries, lifetime cap and slow approval; `test/policy.test.ts` expiry during persistence. |
| 6 | PASS: `src/host.ts` pair races confirm with timeout; `test/link.test.ts` decline, throwing/timed-out confirm and concurrent-confirm save tests. |
| 7 | PASS: `test/link.test.ts` revoke/live socket, failed last-seen save and replacement grants; `test/policy.test.ts` auth/request checks after awaits. |
| 8 | PASS: `test/policy.test.ts` R5, throwing policy in `test/link.test.ts`; handler failures expose only PublicLinkError in `test/link.test.ts` and `test/stream.test.ts`. |
| 9 | PASS: `src/device.ts` sealed refusal gate; `test/link.test.ts` wrong-host response retains grant; `test/policy.test.ts` R4 and R9; plain closes never authorize forgetting. |
| 10 | PASS: `test/pairing.test.ts` and `test/offer-envelope.test.ts` sanitization; seeded offer round trips in `test/parser-fuzz.test.ts`. |
| 11 | PASS: `test/pairing.test.ts`, `test/offer-envelope.test.ts` and seed 0x3c02 cover key/ticket lengths, URL credentials/schemes/count and offer bounds. |
| 12 | PASS: `test/offer-envelope.test.ts` current/legacy checksum, padding, bounds and expiry; seed 0x3c02 round trips 250 offers, aliases, corrupted symbols and invalid fields. |
| 13 | PASS: `test/channel.test.ts` receive/send counter exhaustion and incoming/outgoing 16 MB limits. Found and fixed empty authenticated plaintext accepted as `{}`: `fixtures/conformance/link-frames-typescript.json`, `test/parser-fuzz.test.ts` and real socket close in `test/link.test.ts`. |
| 14 | PASS: `test/stream.test.ts` R5 policy, T4 window overflow/disconnect/revoke and malformed stream data; authenticated bad flags/truncated stream ids in `test/parser-fuzz.test.ts`. |
| 15 | PASS: `test/link.test.ts` blind relay and `../relay/test/relay.test.ts` assert no request, name, plaintext marker or device id in routed frames. Push metadata is explicitly outside this assertion. |
| 16 | PASS: `test/browser.test.ts` esbuild browser boundary and actual headless Chromium pair/request; `test/react-native.test.ts` runs without Node globals. |
| 17 | PASS: `src/host.ts` serialized transition; failed saves/concurrent confirmation in `test/link.test.ts`, R4 expiry closes despite failed save in `test/stream.test.ts`, R9 and X2a in `test/policy.test.ts`. |
| 18 | PASS: `test/policy.test.ts` R5 including concurrent withdrawal and cached replies; throwing canView in `test/link.test.ts`. |
| 19 | PASS: `test/policy.test.ts` R4 auth/requests/timer; `test/stream.test.ts` expired streams despite failed save/arriving frame. |
| 20 | PASS: `test/link.test.ts` concurrent confirmations respect maxDevices; `test/policy.test.ts` M3 per-kind caps; `src/host.ts` counts inside serialized grant transition. |
| 21 | PASS: `test/policy.test.ts` X2a failed staged-key save, promotion, queued old-key auth, retired sockets and staged-key enrolment. |
| 22 | PASS: `src/host.ts` handshake calls admit before firstFrame/Handshake construction; `test/policy.test.ts` T8. Relayed devices count toward the total, not an IP bucket. |
| 23 | PASS: `src/index.ts` portable import closure, browser/RN tests; `src/node.ts` uses exclusive random temp files and hard-link publication, lstat rejects final-path symlinks and unsafe permissions; K1 in `test/policy.test.ts` and temp-symlink checks in `test/stores.test.ts`. |

Seed 0x3c01 adds 300 deterministic stream/JSON round trips, corruption, truncation, replay and
invalid authenticated kind cases. Seeds are fixed in test names for reproducibility. Every parser
rejection test exercises the real parser; authenticated malformed bytes are sealed with Transport
so framing validation is reached rather than only AEAD rejection. The owning conformance fixture
states the missing-kind rule before the source change.

Residual file-system assumption: the app supplies a trusted path and trusted ancestor directories;
`hostKeyFile` checks the immediate parent and final file, not an adversarial ancestor rename race.
This review does not prove timing side-channel resistance or safety of a compromised host/device.
The typed-code PAKE upgrade, at-rest adapter choices and app handler transaction boundary remain
explicit host responsibilities described above.

## Machine-bound typed code review — 2026-09-30

The added checklist row is covered by `test/link.test.ts` (wrong code, replay, five-attempt
lockout, expiry, late approval, refusal, normalization and malformed commitments),
`../relay/test/relay.test.ts` (a substituted responder key fails even when it knows the secret,
before device identity or words), and the browser and React Native pair/request tests.
The Node README example also declines on Enter and approves only on `y`.
This extends the recorded protocol review above; no handshake library or dependency changed.
