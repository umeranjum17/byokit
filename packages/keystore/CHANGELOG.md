# Changelog

## Unreleased

- Add `@byokit/keystore` 0.1.0 (`private: true`): one secret per name from the OS keyring (Keychain /
  Secret Service CLIs, secret on stdin only), a passphrase-sealed file (`sealSecretBox` over scrypt, atomic
  0700/0600 writes), or a host-passed override for CI. The kit never reads `process.env`.

## 0.1.1 (2026-09-30)

- Depends on @byokit/seal 0.2.0; stored secretbox files are unchanged.
