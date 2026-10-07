# Changelog

## Unreleased

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
