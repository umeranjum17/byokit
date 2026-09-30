# Changelog

## Unreleased

- Prepare the desktop/server sealing adapters for public release.

## 0.3.0 (2026-09-30)

- SECURITY: Add native OS-keyring and explicit host-key sealing adapters for accounts files;
  API keys remain authenticated ciphertext with no plaintext or transient-keyring fallback.
- Add native Keychain, Windows Credential Manager and Linux Secret Service storage through
  an exactly pinned optional N-API binding; native errors never include secrets.
- Add key rotation that retains old keys for existing files and backups, injected-keyring
  tests and an isolated real Secret Service CI round trip.

## 0.2.0 (2026-09-30)

- Prepare the first public release with portable phone and web secret storage.

- Add React Native SecureStore and web IndexedDB/WebCrypto AES-GCM backends behind
  the same get/set/delete API, with portable platform entries and an optional Expo peer.
- Web storage persists a non-extractable AES-256 key, authenticates entry names, and
  initializes keys atomically across tabs. Platform errors never include secrets.
- Publish the secret storage kit as `@byokit/secrets` 0.2.0 and remove the private hold.

## 0.1.1 (2026-09-30)

- Depends on @byokit/seal 0.2.0; stored secretbox files are unchanged.

## 0.1.0

- Add one secret per name from the OS keyring, a passphrase-sealed file or a host-passed
  override for CI. The kit never reads the environment.
