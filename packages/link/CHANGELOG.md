# Changelog

## Unreleased

## 0.8.0 (2026-10-09)

- Dependency update: pins @byokit/pair 0.9.0.

- FIX: (from @byokit/pair 0.9.0) a phone killed while the person at the computer decides now resumes against the pinned computer, for compact and version 1 QRs alike. `pairWithOffer` takes `onPending(grant)`, which hands over the pending grant to keep before the computer can approve this device, and `pendingGrant` accepts a compact QR given the authenticated `host` key, and `parseOffer` reads a compact QR for inspection (expiry, addresses, name, role) without one. Before, `pendingGrant` refused compact QRs, and even a version 1 pending grant never came online after a real kill. A socket that drops once the computer has taken the code now ends pairing with `unreachable` instead of trying the next address, where the spent code or ticket could only be refused as `wrong-code` or `expired`. A socket that closes while `onPending` is still saving ends pairing at once with that close; a version 1 `onPending` that never settles times out. The compact QR is unchanged: 109 characters for one relay address and the name Umer.
- SECURITY: (from @byokit/pair 0.9.0) pinning and approval semantics. A compact QR's pending grant pins the key the code handshake authenticated, kept after Noise message 2 and before the device's identity goes out in message 3; if saving it fails, pairing stops before the computer learns the device. A device using `onPending` says so inside the handshake, and only then does the computer keep a yes given after its socket dropped, granting only the device key that handshake authenticated; any other device that leaves still gets no grant. A computer with another key at the same address is still refused, and a version 1 `pendingGrant` refuses a `host` that differs from its QR.
- FIX: (from @byokit/pair 0.9.0) the pairing picture's words match what the host now prints: scan the code, or type the shown code where the phone page asks for it, with no raw address to type.
- FIX: (from @byokit/pair 0.9.0) the browser pairing test closes only the Chromium processes it spawned — over that browser's own private CDP pipe — instead of signalling a whole process group, so a killed or timed-out test can no longer take out or leave behind the wrong process tree. `BYOKIT_CHROME` is the single documented key that selects the test browser.
- Breaking: `parseOffer` now returns `PairOffer | CompactOffer` (re-exported from `@byokit/pair` 0.9.0). Narrow with `'host' in offer`, or call `parseV1Offer`.

## 0.7.1 (2026-10-07)

- Dependency update: pins @byokit/pair 0.8.0.

- **Deprecated:** `@byokit/link` is renamed to `@byokit/pair`. This package is now a shim that re-exports `@byokit/pair` (`@byokit/link` and `@byokit/link/node` alike), so existing imports keep working unchanged through 0.8.x; it is removed in 0.9.0. Install `@byokit/pair` and change the import specifier; the API and the Node-only `./node` entry are the same.

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
