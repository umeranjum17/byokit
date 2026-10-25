# Changelog

## Unreleased

## 0.10.5 (2026-10-25)

- DOCS: align the npm description, keywords and homepage with the BYOKit README; no version bump.

## 0.10.4 (2026-10-18)

- FIX: A code that ran out while the person was saying yes now tells the computer too. When the yes landed after the offer's own expiry but inside the answer time, the device was refused `expired` while `confirm`'s `signal` never aborted, so the computer said nothing; it now aborts once, the same way a run-out during the question does, and still no grant is written.

## 0.10.3 (2026-10-17)

- FIX: A pairing code that runs out while the computer's person has not answered now tells the device "That pairing code has run out" instead of "Your computer said no to this device". `confirm` gets a second argument, `{ signal }`, that aborts when the code runs out so the computer's prompt can close; a yes that comes later grants nothing.

## 0.10.2 (2026-10-17)

- FIX: a busy host that answers a ping late no longer has its live link dropped. `DeviceLink` now counts any pong up to the latest ping, a reply to one of its own waiting requests, or a frame on one of its own streams as hearing from the host, and counts silence from its first ping rather than from the connect, so a host that answers even that first ping late stays online. A host that goes silent is still dropped after two silent ping rounds (`2 × pingMs`, checked once a round). Host events and broadcasts alone still do not keep a link up: they show only that the host can talk, not that it hears the device, so only an answer to something the device sent proves the round trip.

## 0.10.1 (2026-10-16)

- FIX: the browser pairing test opens the pairing page over the test browser's own private CDP pipe once Chromium answers there, not from the launch command line. On a slow first start Chromium's network service quits after 15 s unanswered and took the launch page's request with it, so the test silently sat out its 180 s deadline; the page now loads after Chromium restarts the service, and a page Chromium cannot open fails at once with Chromium's own navigation error.
- FIX: pairing and setup checks split "can't reach the computer" from "the computer is slow": a socket that never opens within the timeout reports `unreachable` ("Check the phone and computer are on the same network, and that no firewall is blocking the connection."), while an open socket with no answer reports the new `slow` code ("Your computer is slow to answer. Wait a moment and try again."). Consumers relay the codes unchanged.

## 0.10.0 (2026-10-12)

- DOCS: the "Checking reachability before pairing" section now shows both sides: setup self-checks its own advertised URLs with `check()` before printing the tick, and the phone re-checks the scanned offer before consent. The probe still spends nothing, so a checked offer pairs afterwards.
- ADD: `ndjson(stream)` sends and receives whole JSON messages over a pair stream, one per `\n`-terminated line, through the existing credit window. Chunks split at any byte boundary reassemble before decoding, a line past `NDJSON_MAX_LINE` (1 MiB, configurable per stream) ends the stream with `line-too-long` on both ends, and a non-JSON line ends it with `failed`.
- FIX: every wait in the link end-to-end suite is bounded: each test carries a one-minute deadline, so a request stalled past its reconnect window (twice it parked the whole full-suite run at 0% CPU until killed) fails by its test name instead of hanging every lane and release behind the shared test lock. The file still passes in about 10 s alone; nothing about the protocol changed.

## 0.9.0 (2026-10-09)

- FIX: a phone killed while the person at the computer decides now resumes against the pinned computer, for compact and version 1 QRs alike. `pairWithOffer` takes `onPending(grant)`, which hands over the pending grant to keep before the computer can approve this device, and `pendingGrant` accepts a compact QR given the authenticated `host` key, and `parseOffer` reads a compact QR for inspection (expiry, addresses, name, role) without one. Before, `pendingGrant` refused compact QRs, and even a version 1 pending grant never came online after a real kill. A socket that drops once the computer has taken the code now ends pairing with `unreachable` instead of trying the next address, where the spent code or ticket could only be refused as `wrong-code` or `expired`. A socket that closes while `onPending` is still saving ends pairing at once with that close; a version 1 `onPending` that never settles times out. The compact QR is unchanged: 109 characters for one relay address and the name Umer.
- SECURITY: pinning and approval semantics. A compact QR's pending grant pins the key the code handshake authenticated, kept after Noise message 2 and before the device's identity goes out in message 3; if saving it fails, pairing stops before the computer learns the device. A device using `onPending` says so inside the handshake, and only then does the computer keep a yes given after its socket dropped, granting only the device key that handshake authenticated; any other device that leaves still gets no grant. A computer with another key at the same address is still refused, and a version 1 `pendingGrant` refuses a `host` that differs from its QR.
- `parseOffer` now returns `PairOffer | CompactOffer`, so a compact QR parses for inspection. Code that reads `.host` or `.ticket`, or passes the result to `offerText` or `encodeOffer`, narrows with `'host' in offer`, or calls the new `parseV1Offer` for the old version 1-only type.
- FIX: the pairing picture's words match what the host now prints: scan the code, or type the shown code where the phone page asks for it, with no raw address to type.
- FIX: the browser pairing test closes only the Chromium processes it spawned — over that browser's own private CDP pipe — instead of signalling a whole process group, so a killed or timed-out test can no longer take out or leave behind the wrong process tree. `BYOKIT_CHROME` is the single documented key that selects the test browser.

## 0.8.0 (2026-10-07)

- Add redacted startup, page/module and link-stage diagnostics to the browser pairing test; the intermittent CI timeout's root cause remains unknown.
- The browser pairing test now keeps the browser's own scrubbed launch log, exit code and runner pressure next to its result (CI uploads them), stops waiting the moment the browser exits, and names the last step reached when it times out.
- Add `Host.compactOffer`: a QR-sized pairing offer carrying the same secret a typed code uses (same single use, short life, two-word compare and device approval, through one code entry) plus the packed dial addresses. A standard single-address offer encodes to under 80 characters, so its QR is version 4 or lower and fits an 80x24 terminal. `pairWithOffer` scans both compact and `byokit-link:1` offers; version 1 generation and parsing are unchanged.
- Add optional `onGrantRemoved` privacy cleanup at the canonical durable grant-removal, expiry and authority-change boundary, including offline grants. Access is invalidated before cleanup is awaited; socket drops do not trigger it, and cleanup failure never restores access.
- `@byokit/link` is now published as `@byokit/pair`, with the same API and the same Node-only `./node` entry; its earlier versions are the `@byokit/link` releases below. **Deprecated:** the `@byokit/link` name; it stays published as a shim that re-exports this package through 0.8.x and is removed in 0.9.0.

## 0.7.0 (2026-10-01)



- SECURITY: `Host.shortCode()` adds a machine-key commitment to typed pairing; `pairWithCode()` verifies it before disclosing device identity or asking for approval. Legacy codes remain compatible; use the full new code when relay lookup is untrusted.
- Add `check(urls, { timeoutMs, concurrency, WebSocket })`: a per-URL reachability probe returning a `LinkProblem`
  code plus its `LINK_WORDS` sentence, in input order. The host answers a new unauthenticated probe frame read-only
  (no ticket, code, grant or counter touched; the reply leaks nothing but reachability), so a checked offer still
  pairs afterwards. Runs in Node, browsers and React Native, direct and through a relay.
- Add `onConnection(grant, online)` presence with first/last socket events and no duplicate-socket flapping.
- Add serialized `Host.reload()`, optional `GrantStore.subscribe` notifications and Node `fileGrantStore`
  with cross-process file notifications and stale-write protection.
- Add opt-in `deviceMeta` in sealed ready replies, kept after pairing and refreshed on reconnect.
- Add `secureDeviceStores` and `browserDeviceStores` collections with list, named load/save/remove and link adapters.
- Document and test constrained delegated pairing through host-issued short-lived invitations.
- Add `Host.shortCode(terms)` for small terminals, with the existing word comparison, explicit host approval, single-use window and five-attempt limit (minor release).

## 0.6.0 (2026-09-30)



- Add `migrateGrant(raw, { format: 'crewhouse-v0' })` for pre-kit phone pairings, with key, fingerprint and shape validation and typed errors.

## 0.5.1 (2026-09-30)

- FIX: Reject an authenticated empty transport frame instead of decoding it as an empty control message.
- Record the 23-item protocol review and add seeded frame, pairing offer and offline envelope fuzz tests.

## 0.5.0 (2026-09-30)

- FIX: `decodeOffer()` reads legacy compact direct pairing codes with checksum, padding, bounds and expiry validation; new encodings keep the complete current format.


## 0.4.0 (2026-09-30)

- Export `parseOffer`, `cleanName`, `offerText`, `encodeOffer` and `decodeOffer`.
- Add browser pairing and short-lived peer invitation recipes, with a view-only PWA example.

## 0.3.2 (2026-09-29)

- FIX: a phone app coming back from the background, or a hidden browser tab, no longer drops
  a healthy link. A ping check that runs late because the device's own timers were frozen now
  counts the silence from when it runs instead of mistaking it for a quiet host; a host that
  is really silent still drops after missing the pings that follow.

## 0.3.1

- SECURITY: Node hostKeyFile/device store wrote the device secret through a predictable temp path that followed symlinks; now a random O_EXCL 0600 temp file

- React Native `secureDeviceStore` keeps device grants in platform secure storage.
- Browser `browserDeviceStore` seals grants in IndexedDB, orders saves with clears across tabs when Web Locks are available, and blocks saves of the last forgotten device ID.
- Node/Electron `fileDeviceStore` persists grants in a private file, optionally sealed by Electron safeStorage.
