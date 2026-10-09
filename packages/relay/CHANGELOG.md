# Changelog

## Unreleased

## 0.6.0 (2026-10-09)

- Dependency update: pins @byokit/link 0.8.0.

- New: `POST /relay/v1/push/action` accepts an optional bounded `reply`, an opaque sealed ciphertext (for example a
  free-text answer sealed to the host's key) that the relay forwards unchanged to the host's `onAction` as
  `PushAction.reply` and never reads or stores. It must be a non-empty string of at most `MAX_ACTION_REPLY` (8192)
  UTF-8 bytes, refused otherwise before the one-use token is spent. Token, action authorization and rate limits are
  unchanged.
- FIX: (from @byokit/pair 0.9.0) a phone killed while the person at the computer decides now resumes against the pinned computer, for compact and version 1 QRs alike. `pairWithOffer` takes `onPending(grant)`, which hands over the pending grant to keep before the computer can approve this device, and `pendingGrant` accepts a compact QR given the authenticated `host` key, and `parseOffer` reads a compact QR for inspection (expiry, addresses, name, role) without one. Before, `pendingGrant` refused compact QRs, and even a version 1 pending grant never came online after a real kill. A socket that drops once the computer has taken the code now ends pairing with `unreachable` instead of trying the next address, where the spent code or ticket could only be refused as `wrong-code` or `expired`. A socket that closes while `onPending` is still saving ends pairing at once with that close; a version 1 `onPending` that never settles times out. The compact QR is unchanged: 109 characters for one relay address and the name Umer.
- SECURITY: (from @byokit/pair 0.9.0) pinning and approval semantics. A compact QR's pending grant pins the key the code handshake authenticated, kept after Noise message 2 and before the device's identity goes out in message 3; if saving it fails, pairing stops before the computer learns the device. A device using `onPending` says so inside the handshake, and only then does the computer keep a yes given after its socket dropped, granting only the device key that handshake authenticated; any other device that leaves still gets no grant. A computer with another key at the same address is still refused, and a version 1 `pendingGrant` refuses a `host` that differs from its QR.
- FIX: (from @byokit/pair 0.9.0) the pairing picture's words match what the host now prints: scan the code, or type the shown code where the phone page asks for it, with no raw address to type.
- FIX: (from @byokit/pair 0.9.0) the browser pairing test closes only the Chromium processes it spawned — over that browser's own private CDP pipe — instead of signalling a whole process group, so a killed or timed-out test can no longer take out or leave behind the wrong process tree. `BYOKIT_CHROME` is the single documented key that selects the test browser.

## 0.5.3 (2026-10-07)

- Dependency update: pins @byokit/link 0.7.1.

- Added `quietHours: { start, end }` (UTC `HH:MM`, overnight windows wrap midnight):
  notifications inside the window are held and delivered in order when it ends;
  `urgency: 'high'` always sends at once. `notify()` reports `{ held: true }`.
- Push delivery failures (service 500, unreachable service) lose the one
  notification, never the subscription, so the retry after recovery still sends.
- `findHost` failure paths report a wrong code, an unreachable relay, and a
  forged address distinctly.
- Dependency update: ws 8.22.0.

## 0.5.2 (2026-10-02)

- FIX: Pass optional `mutableContent`, `categoryId` and `dataOnly` from `Notification` to Expo instead of dropping
  native delivery options: iOS alerts can be rewritten by
  the app's Notification Service Extension and show the app's category, and Android tokens get a data-only message
  with no visible title, body or sound. Expo subscriptions take an optional `platform` (`'ios'` or `'android'`);
  only Android tokens get data-only messages, so older subscriptions keep the visible alert.
- New: Optional Expo subscription platform tags distinguish Android data-only delivery from iOS and older visible subscriptions.
- Fixed: Native delivery options are retained as described above; omitted options keep the existing visible Expo message unchanged.
- Improved: Explicit false mutableContent survives forwarding; contentFreeNotify strips native options and content, and includeContent remains opt-in. Web Push is unchanged.
- Known issues: Data-only delivery is best-effort under Android Doze and force-stop. iOS SDK, keychain entitlements, NSE and killed-app/device delivery are not qualified; mutableContent alone does not install an extension. categoryId currently uses the documented conservative 64-character syntax.

## 0.5.1 (2026-10-01)

- FIX: Wait for the temporary pairing socket to close before checking live device counts in the reconnect job test.

## 0.5.0 (2026-10-01)

- Dependency update: pins @byokit/link 0.7.0.

- Add host-owned `JobChannel` history and portable `readJobStream`: ordered text, image bytes, usage and end
  frames over encrypted link streams, with device-scoped job ids and replay after a reconnect cursor.
  History is bounded and in memory; execution, retention and subscription/API key (billed per use) policy stay app-supplied.
- Add owner-set enrolment `meta` (JSON capped at 4096 UTF-8 bytes), retained in the host record and exposed in
  `ready` / `RelayClient.meta`, including on reconnect. URL fields stay app-defined and metadata never reaches devices.
- Add host-authenticated `RelayClient.self()` and `leave()`: read only the proven host's own record and live device
  connection count, or remove its registration, push addresses, action tokens and short codes. Leave clears confirmed
  pending unsubscriptions from the existing client store and stops; failed relay saves retain authority for retry.
- Test machine-bound typed pairing through relay lookup, including rejection of a substituted host key before device identity is sent.

## 0.4.2 (2026-09-30)

- Dependency update: pins @byokit/link 0.6.0.

## 0.4.1 (2026-09-30)

- Dependency update: pins @byokit/link 0.5.1.

- FIX: (from @byokit/link 0.5.1) Reject an authenticated empty transport frame instead of decoding it as an empty control message.
- Document the relay threat model and review evidence; add seeded push envelope and host-proof fuzz tests.

## 0.4.0 (2026-09-30)

- Add explicit capped open signup on self-hosted relays, with proof of key and atomic registration.
- Add a server notification filter and `contentFreeNotify(title)` preset for fixed-title pushes with hashed ids
  and no body, data or buttons.
- Add trusted host/tenant rate-limit bucket selection, retaining per-IP limits by default, and document
  durable reconnect reconciliation.

## 0.3.1 (2026-09-30)

- FIX: (from @byokit/link 0.5.0) `decodeOffer()` reads legacy compact direct pairing codes with checksum, padding, bounds and expiry validation; new encodings keep the complete current format.
- Dependency update: pins @byokit/link 0.5.0.


## 0.3.0 (2026-09-30)

- Add `ownerClient(url, token)` for listing hosts, creating enrolments and revoking hosts, with injectable fetch
  and typed HTTP errors, and `linkUrl(relay, hostId)` in the device entry for constructing link addresses.

## 0.2.2 (2026-09-30)

- Depends on @byokit/link 0.4.0.

## 0.2.1
- FIX: A half-open host socket no longer looks alive forever. `RelayClient` pings the relay every
  20 s (`pingMs` option) and the relay answers `pong`; after two silent rounds the client closes
  the socket and reconnects through the usual offline+backoff path. A tick that fires late because
  the host's own timers were frozen resets the silence instead of closing, the same guard as
  link's `DeviceLink.ping`.

## 0.2.0 (2026-09-29)

- SECURITY: Removing a phone now reliably stops its push notifications, even if the relay was down or restarting when
  you removed it. Before, `RelayClient.revoke` dropped the device's grant and sent one unsubscribe that was lost if the
  offline queue overflowed or the host stopped or restarted before the relay was back, so the relay kept the phone's
  push address.
  Now the unsubscribe is saved first and resent on every connection until the relay confirms it; `revoke()` resolves
  then. Pass a durable `store` to `RelayClient` so a pending unsubscribe survives a restart (the default is memory).
- New in `RelayClient`: `store` and `onRevoked` options and `pending()`; `subscribe` refuses a device still being
  revoked.
- Depends on @byokit/link 0.3.2.

## 0.1.3
- FIX: A failed connect now always reconnects. On Node 22 a refused WebSocket fires only `error` (never `close`), and 0.1.2 scheduled its retry only from `close`, so after the first failed reconnect the host sat at `connecting` forever and never re-registered: 0.1.2 did NOT reconnect on Node 22, despite its note. Contract now, on Node 22.18+, 24 and 26 (all tested, including a real refused socket): the host process stays up, onStatus reports offline, one retry is scheduled per failed socket with the existing backoff (1 s doubling to 30 s, jittered), queued requests stay queued, and the host registers once the relay is listening again.

## 0.1.2
- FIX: A relay that is unreachable at connect time no longer crashes the process on Node 22 (a CONNECTING socket's error handler called close(), which re-emitted error recursively). Behaviour now: the socket closes on its own, onStatus reports offline, and the client retries with the existing backoff (1 s doubling to 30 s, jittered); queued requests stay queued; no new error is thrown to the caller. Pure crash removal - no new error path to handle.
