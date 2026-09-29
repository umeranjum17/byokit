# Changelog

## Unreleased

- Add `@byokit/keystore` 0.1.0 (`private: true`): one secret per name from the OS keyring (Keychain /
  Secret Service CLIs, secret on stdin only), a passphrase-sealed file (`sealSecretBox` over scrypt, atomic
  0700/0600 writes), or a host-passed override for CI. The kit never reads `process.env`.
