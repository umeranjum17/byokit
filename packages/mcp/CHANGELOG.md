# Changelog

## Unreleased

## 0.2.1 (2026-10-29)

- Dependency update: pins @byokit/pair 0.11.0.
- SECURITY: (from @byokit/pair 0.11.0) A host may now request a pairing offer longer than five minutes (the default is unchanged), which widens how long an offer stays usable.
- FIX: (from @byokit/pair 0.11.0) A pong for a ping that went unanswered for two rounds no longer keeps a link alive; a pong for a ping still outstanding does, so a busy computer's late answer keeps the link.

- Dependency update: pins @modelcontextprotocol/sdk 1.32.2.

## 0.2.0 (2026-10-25)

- Dependency update: pins @byokit/secrets 0.5.3.
- Dependency update: pins @byokit/pair 0.10.5.

- DOCS: align npm descriptions, keywords and homepages with the BYOKit README.
- BREAKING: depends on zod 4.6.7 (was 3.25.76), the first release without GHSA-mrhx-c7xc-m3w5 (a validator can be made to exhaust memory on oversized constrained collections); no zod 3 release carries the fix. Tool input schemas passed to `tool()` are now zod 4 schemas, so import `z` from zod 4 (`npm install zod@4`); zod 3 schemas no longer type-check.

## 0.1.8 (2026-10-18)

- Dependency update: pins @byokit/pair 0.10.4.
- FIX: (from @byokit/pair 0.10.4) A code that ran out while the person was saying yes now tells the computer too. When the yes landed after the offer's own expiry but inside the answer time, the device was refused `expired` while `confirm`'s `signal` never aborted, so the computer said nothing; it now aborts once, the same way a run-out during the question does, and still no grant is written.

## 0.1.7 (2026-10-17)

- Dependency update: pins @byokit/pair 0.10.3.

- Dependency update: pins @modelcontextprotocol/sdk 1.32.1.

## 0.1.6 (2026-10-17)

- Dependency update: pins @byokit/secrets 0.5.2.

## 0.1.5 (2026-10-17)

- Dependency update: pins @byokit/pair 0.10.2.
- FIX: (from @byokit/pair 0.10.2) a busy host that answers a ping late no longer has its live link dropped. `DeviceLink` now counts any pong up to the latest ping, a reply to one of its own waiting requests, or a frame on one of its own streams as hearing from the host, and counts silence from its first ping rather than from the connect, so a host that answers even that first ping late stays online. A host that goes silent is still dropped after two silent ping rounds (`2 × pingMs`, checked once a round). Host events and broadcasts alone still do not keep a link up: they show only that the host can talk, not that it hears the device, so only an answer to something the device sent proves the round trip.

## 0.1.4 (2026-10-16)

- Dependency update: pins @byokit/pair 0.10.1.
- FIX: (from @byokit/pair 0.10.1) the browser pairing test opens the pairing page over the test browser's own private CDP pipe once Chromium answers there, not from the launch command line. On a slow first start Chromium's network service quits after 15 s unanswered and took the launch page's request with it, so the test silently sat out its 180 s deadline; the page now loads after Chromium restarts the service, and a page Chromium cannot open fails at once with Chromium's own navigation error.
- FIX: (from @byokit/pair 0.10.1) pairing and setup checks split "can't reach the computer" from "the computer is slow": a socket that never opens within the timeout reports `unreachable` ("Check the phone and computer are on the same network, and that no firewall is blocking the connection."), while an open socket with no answer reports the new `slow` code ("Your computer is slow to answer. Wait a moment and try again."). Consumers relay the codes unchanged.

## 0.1.3 (2026-10-12)

- Dependency update: pins @byokit/secrets 0.5.1.
- Dependency update: pins @byokit/pair 0.10.0.

- Dependency update: depend on `@byokit/pair` 0.9.0 instead of its deprecated `@byokit/link` shim.

## 0.1.2 (2026-10-09)

- Dependency update: pins @byokit/link 0.8.0.
- FIX: (from @byokit/pair 0.9.0) a phone killed while the person at the computer decides now resumes against the pinned computer, for compact and version 1 QRs alike. `pairWithOffer` takes `onPending(grant)`, which hands over the pending grant to keep before the computer can approve this device, and `pendingGrant` accepts a compact QR given the authenticated `host` key, and `parseOffer` reads a compact QR for inspection (expiry, addresses, name, role) without one. Before, `pendingGrant` refused compact QRs, and even a version 1 pending grant never came online after a real kill. A socket that drops once the computer has taken the code now ends pairing with `unreachable` instead of trying the next address, where the spent code or ticket could only be refused as `wrong-code` or `expired`. A socket that closes while `onPending` is still saving ends pairing at once with that close; a version 1 `onPending` that never settles times out. The compact QR is unchanged: 109 characters for one relay address and the name Umer.
- SECURITY: (from @byokit/pair 0.9.0) pinning and approval semantics. A compact QR's pending grant pins the key the code handshake authenticated, kept after Noise message 2 and before the device's identity goes out in message 3; if saving it fails, pairing stops before the computer learns the device. A device using `onPending` says so inside the handshake, and only then does the computer keep a yes given after its socket dropped, granting only the device key that handshake authenticated; any other device that leaves still gets no grant. A computer with another key at the same address is still refused, and a version 1 `pendingGrant` refuses a `host` that differs from its QR.
- FIX: (from @byokit/pair 0.9.0) the pairing picture's words match what the host now prints: scan the code, or type the shown code where the phone page asks for it, with no raw address to type.
- FIX: (from @byokit/pair 0.9.0) the browser pairing test closes only the Chromium processes it spawned — over that browser's own private CDP pipe — instead of signalling a whole process group, so a killed or timed-out test can no longer take out or leave behind the wrong process tree. `BYOKIT_CHROME` is the single documented key that selects the test browser.

## 0.1.1 (2026-10-07)

- Dependency update: pins @byokit/link 0.7.1.

## 0.1.0 (2026-10-01)



- Hosted streamable HTTP tools and resources with device sign-in, hashed credentials, per-request authentication and user-bound sessions.
