# Changelog

## 0.1.0

- SECURITY: NaCl-compatible box and secretbox authenticated ciphertext is rejected on tamper or wrong keys without exposing plaintext.
- FIX: Preserve libsodium seeded X25519 and XSalsa20-Poly1305 byte formats for existing stored payloads, without a data migration.
- Add portable Ed25519 detached signatures with tweetnacl-style 64-byte secret keys.
