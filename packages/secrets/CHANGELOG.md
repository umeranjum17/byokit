# Changelog

## Unreleased

## 0.5.0 (2026-09-30)



- SECURITY: Add opt-in dual wrapping with a keyring and owner-only host key; its protection is only as strong as the host-key file, which must stay out of sealed-store backups. The default remains keyring-only when available.
- FIX: Open sealed stores using their header mode, even after a locked start creates a fallback directory. Locked or unresponsive keyring-only reads report recoverable keyring-locked and preserve the store; unlocked reads can atomically upgrade existing stores to opt-in dual wrapping.

## 0.4.0 (2026-09-30)



- SECURITY: Automatic sealing uses a persistent owner-only host key when a non-interactive keyring is unavailable; exclude the key directory from sealed-store backups and lock all writers during rotation.
- FIX: Headless, locked and unresponsive keyrings no longer require manual key provisioning or trigger an unlock prompt; sealing reports its active mode and file-key rotation resumes interrupted rewrites.

- Prepare the desktop/server sealing adapters for public release.

## 0.3.0 (2026-09-30)

- SECURITY: Add native OS-keyring and explicit host-key sealing adapters for accounts files;
  API keys remain authenticated ciphertext with no plaintext or transient-keyring fallback.
- SECURITY: Real keyring tests clear inherited desktop settings and validate a private
  D-Bus session before native calls; opt-in alone cannot reach the user keyring.
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
