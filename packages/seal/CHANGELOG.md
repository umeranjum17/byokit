# Changelog

## Unreleased

## 0.2.0 (2026-09-30)

- Add raw X25519 key pairs and known-sender authenticated boxes with NaCl-compatible byte formats.
- Add generic JSON notice envelopes sealed to a recipient public key.
- `openBox` now takes a raw X25519 secret; use `openBoxFromSeed` for the previous seed-based call. `boxKeyPairFromSeed` is unchanged.

## 0.1.0

- SECURITY: NaCl-compatible box and secretbox authenticated ciphertext is rejected on tamper or wrong keys without exposing plaintext.
- FIX: Preserve libsodium seeded X25519 and XSalsa20-Poly1305 byte formats for existing stored payloads, without a data migration.
- Add portable Ed25519 detached signatures with tweetnacl-style 64-byte secret keys.
