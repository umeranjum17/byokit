# Changelog

## Unreleased

## 0.3.0 (2026-10-02)

- Add a Swift notice opener for iOS Notification Service Extensions (`ios/Sources/ByokitSeal`, CryptoKit only):
  `ByokitSeal.openNotice` opens `sealNotice` envelopes with the same bytes and failures as the TypeScript
  `openNotice`, from an envelope or an Expo notification's `userInfo`, and `keychainSecret` reads the app's notice
  secret from one item in a shared keychain access group. Parity vectors are made by the TypeScript tests and opened
  by libsodium.
- New: Ship ByokitSeal.openNotice for envelope and Expo userInfo input plus keychainSecret for one app-owned shared-group keychain item; the kit never stores notice keys.
- Fixed: No additional fixes in this release.
- Improved: Stock pinned Linux Swift 5.10.1 passes all 35 TypeScript-owned notice vectors and Expo userInfo extraction. Existing TypeScript formats and portable APIs remain unchanged.
- Known issues: Linux parity does not prove Apple SDK compilation, Security/keychain entitlements, an iOS Notification Service Extension or killed-app/device delivery. Apps must integrate and qualify their own NSE; platform delivery remains best-effort with generic-alert fallback. Lone UTF-16 surrogates open in TypeScript but are nil in Swift; seal well-formed text.

## 0.2.0 (2026-09-30)

- Add raw X25519 key pairs and known-sender authenticated boxes with NaCl-compatible byte formats.
- Add generic JSON notice envelopes sealed to a recipient public key.
- `openBox` now takes a raw X25519 secret; use `openBoxFromSeed` for the previous seed-based call. `boxKeyPairFromSeed` is unchanged.

## 0.1.0

- SECURITY: NaCl-compatible box and secretbox authenticated ciphertext is rejected on tamper or wrong keys without exposing plaintext.
- FIX: Preserve libsodium seeded X25519 and XSalsa20-Poly1305 byte formats for existing stored payloads, without a data migration.
- Add portable Ed25519 detached signatures with tweetnacl-style 64-byte secret keys.
