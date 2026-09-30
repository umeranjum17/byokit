# Security boundaries

The relay routes `@byokit/link` device frames as ciphertext and does not authenticate link devices; the host authenticates them during the link handshake. The relay does see host addresses, connection metadata, push subscriptions, device grant IDs used for push, and notification actions.

Push notification text is the exception to the no-plaintext link boundary. The relay reads the notification title and any body or data the host explicitly includes. `RelayClient.notify` omits body and data by default; `{ includeContent: true }` forwards them. Use generic titles and fetch private details over the link. Expo and its delivery providers can read Expo notification text. Web Push payloads are encrypted for the browser by the relay, so the relay reads them before encryption even though the push service cannot decrypt them.

Web Push endpoints are restricted to the configured subset of known HTTPS push-service hosts. Redirects are not followed. Keep the relay's store private: it contains host registrations, enrolment claim hashes, push subscriptions and VAPID keys.

## Owner HTTP client

`ownerClient` uses the relay's existing owner-only routes. Its bearer token can list every host, create enrolment
claims and revoke hosts; keep it on the owner's trusted side, never in device grants, pairing URLs or public browser
code. The app supplies both the relay URL and token (and may supply `fetch`); the kit does not operate a relay or
discover credentials. Use HTTPS outside loopback. Requests refuse redirects, and HTTP errors expose only the status
and a fixed message, never the relay's response body. An injected fetch must honor that redirect policy.

`linkUrl` builds an address from a public host id and does not grant access: the host still authenticates each device
through link. `findHost` uses the same address construction after the short-code lookup.

## Device revoke

`RelayClient.revoke(device)` saves the device to the client's `store` before removing its link grant, and resends the unsubscribe on every connection until the relay confirms that the device's push subscriptions and action tokens are gone (or the relay no longer has the host at all). A relay that is down, restarting or behind a full offline queue delays the removal but no longer loses it. The default store is memory: without a durable one, a host that restarts before the relay confirms forgets the pending unsubscribe, and the relay may keep notifying the removed device.

## Self-hosted policy options

Enrolment-only signup remains the default. Open signup explicitly admits any key that proves possession, up to the
configured automatic-registration cap. Concurrent registrations share the serialized store update. The cap includes
existing registrations, never evicts them, and does not constrain the owner's explicit `admit`. Open signup allows a
revoked key to register again; use enrolment-only signup when revocation must prohibit automatic return.

The server `notify` hook enforces delivery policy on every host. `contentFreeNotify(title)` replaces the title, hashes
the id and removes body, data and actions before delivery. It preserves delivery hints and recipients. The relay still
receives the original plaintext; this protects what leaves it, not what an untrusted relay can read. A deterministic
hash is opaque text, not encryption, and guessable ids remain guessable. Filter exceptions and invalid output stop
delivery; filter code is trusted app code.

`limitKey` is trusted app policy and replaces the address bucket when it returns a key. Host context is supplied only
from successful key proof or an unexpired action capability, never from a claimed key or URL. Pre-authentication
requests retain per-IP limits unless the app supplies a key; tenant mappings must come from trusted authentication,
not unchecked headers. Categories remain separate and the existing counts/windows apply.

## Threat model

The relay is a trusted registrar and push sender, and an untrusted carrier of link ciphertext.
Its assets are the owner bearer token, admitted host keys, single-use enrolment claims,
push subscriptions, VAPID private key and push-action capabilities. The owner token is
supplied by the app and stays in memory; enrolment claim secrets are stored only as SHA-256
hashes. The store contains authority and personal metadata and must be private and durable.
A restored old snapshot may restore revoked authority; the kit supplies no at-rest encryption.

| Actor | Ability and boundary |
|---|---|
| Passive observer | Sees addresses, timing and sizes. HTTPS/WSS protects relay control traffic in deployment; link Noise protects routed payloads independently. Cleartext HTTP/WS is for trusted loopback only. |
| Unauthenticated remote client | Can try WebSocket connections, code lookups and action tokens. Host registration requires a fresh X25519 DH/HMAC-SHA256 proof bound to the nonce, host key and relay key, plus existing admission, a valid enrolment, or explicitly configured capped open signup. Zero/low-order keys, forged and replayed proofs fail. Device sockets route only to the selected host and confer no relay control authority. |
| Holder of an enrolment claim | Can admit one key within five minutes after proving possession. Admission is serialized with store persistence, so concurrent claims have one winner. Transfer claims over a trusted channel; anyone possessing a live claim can race the intended host. |
| Admitted host | Can replace its own live socket, create short lookup codes, manage its own push records and send its own notifications. It cannot answer another host's push actions or revoke another host. It controls notification text and can abuse its own subscribers; admission is the owner's trust decision (open signup deliberately delegates that decision to proof of key). |
| Malicious device | Can flood routed frames; only the link host authenticates its key and enforces grants. Push subscription ownership is vouched for by the host, not independently proven by the relay. |
| Malicious relay/operator | Can misroute/drop traffic, forge push notifications/actions, replace or leak stored authority and metadata, or return misleading short-code lookups. Cannot decrypt or authenticate as a pinned link host or device. A short lookup code is discovery, not link authentication. Apps must authorize actions again at the host. |
| Attacker holding owner token or store | Owner token permits listing/enrolling/revoking all hosts. Store control can restore grants, change subscriptions and use the VAPID key. This is outside the relay's protection; restrict access and rotate compromised owner tokens/keys through the host app. |

## Controls and limits

- Host registration has a fresh challenge per socket and a 10-second hello timeout. Enrolment secrets
  have 256 random bits; a consumed or expired claim cannot authorize a second host.
- Store transitions clone, serialize and save before publishing memory. A failed save does not
  install authority. Revocation closes live host/device sockets after persistence and removes
  lookup codes, push records and action tokens.
- WebSocket messages are bounded at 2 MB; HTTP JSON bodies at 16 KB. There are at most 256
  live device sockets per host. Default per-address minute limits are 60 connections, 10 code lookups,
  20 actions, 10 enrolment claims and 10 failed proofs. `trustProxy` is safe only behind an app-owned
  proxy that overwrites X-Forwarded-For; otherwise clients can bypass address buckets.
- Short lookup codes have six unbiased base31 characters, expire within five minutes and are
  capped at 16 per host. They are weaker than pairing credentials and are never used to authenticate.
- Notification ids, text, recipient/action lists and TTL are validated. Push endpoints must use
  HTTPS without credentials or a nondefault port, with a hostname in the configured subset of
  the fixed push-service allowlist. Redirects are rejected; injected fetch must honor this.
- Action tokens have 144 random bits, are bound to host/device/event and known actions, expire
  with the notification TTL, and are consumed before a connected host acts. A disconnected host
  leaves the token available for retry; a consumed token stays consumed on timeout. Only the
  live host to which the action was sent may answer it.
- Notification deduplication (2048 ids per host), action tokens (4096 globally), lookup codes and
  live state are memory-only. Restart loses deduplication and may redeliver a retried notification.
  Actions are not a substitute for authenticated, idempotent host policy.
- The 2 MB frame and connection caps do not bound queued WebSocket output. There is no relay
  routing backpressure or notification-rate quota. Open signup caps automatic registrations,
  but explicit owner admission has no global live-host cap. Rate buckets clear after
  10,000 entries; distributed clients can evade per-address limits. Put public deployments behind
  connection, bandwidth and push-cost limits. This review does not claim denial-of-service immunity.
- Offline client queues are bounded. Pending device push removals survive reconnection only
  when the app provides a durable RelayClient store (see Device revoke above).

## Recorded review — 2026-09-30

Source and executable review originally based on `9ee1846`, then revalidated after rebasing onto
`06efc31`, including the self-hosted policy additions; not an independent crypto audit.
The checklist below records controls actually exercised by the loopback/fake-fetch tests. Paths
are relative to this package. Run after `npm ci` and `npm run build`:

```sh
TMPDIR=/tmp sh scripts/test.sh 'packages/link/test/*.test.ts' 'packages/relay/test/*.test.ts'
```

- [x] Host proof requires the presented key and fresh challenge; enrolment/admission is the default, with explicitly capped open signup tested in `test/enrolment.test.ts`: `test/strict-auth.test.ts`, `test/enrolment.test.ts`; seed 0x3c04 in `test/parser-fuzz.test.ts` adds 64 challenge-bound proof, tamper, low-order and truncated-input cases.
- [x] Claims are single use and serialize concurrent admissions; expired and forged claims fail: `test/enrolment.test.ts`, `test/strict-auth.test.ts`.
- [x] Only owner bearer requests manage all hosts; owner client refuses redirects and suppresses response bodies: `test/strict-auth.test.ts`, `test/enrolment.test.ts`.
- [x] Failed saves preserve authority; delayed saves cannot install revoked hosts: `test/enrolment.test.ts`, `test/push.test.ts`.
- [x] Routed link frames contain no plaintext marker, device name, operation or device grant id: `test/relay.test.ts`; host revocation closes its devices and leaves another host intact: `test/enrolment.test.ts`.
- [x] Address limits, replacement/reconnect and keepalive work: `test/strict-auth.test.ts`, `test/relay.test.ts`, `test/keepalive.test.ts`.
- [x] Push has the documented content exception and defaults to omitting body/data: `test/push.test.ts`; subscription removal is host/device scoped.
- [x] SSRF boundaries include restored subscriptions and refused redirects: `test/push.test.ts`; seed 0x3c03 in `test/parser-fuzz.test.ts` adds 500 valid/invalid JSON envelope cases with lookalike hosts, URL userinfo, loopback, schemes, ports, configured empty allowlist and field limits.
- [x] Actions are single use, bounded by expiry and known buttons, and answers are bound to their receiving host: `test/push.test.ts`.
- [x] Pending device revoke is saved before link removal and replayed until confirmed, including failed saves/restarts: `test/revoke.test.ts`.

- [x] Self-hosted policy additions preserve proof requirements and atomic registration caps; notification filters validate their outputs and content-free delivery strips body/data/actions; trusted limit keys receive proved host context: `test/enrolment.test.ts`, `test/push.test.ts`, `test/strict-auth.test.ts`. Open signup permits a revoked key to register again, as documented above.

The seeded tests are deterministic and run offline with the normal test egress guard. They cover
JSON values reachable from the wire, not hostile in-process getters, proxies or cyclic objects.
No production relay, account, notification provider or host credentials are used by this review.
