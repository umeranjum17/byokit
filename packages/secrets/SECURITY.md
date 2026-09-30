# @byokit/secrets: threat model and review checklist

## What it protects

Apps hold API keys. The store must make sure that:

1. a key at rest lives in the OS keyring, native SecureStore, a passphrase-sealed file or authenticated web ciphertext, never in a plaintext file;
2. a key in motion to the keyring CLI cannot be seen in `ps`, shell history, logs or the environment;
3. a wrong passphrase opens nothing and changes nothing;
4. the environment cannot smuggle a key or an entry into the kit (the kit never reads it);
5. a key never appears in an error, a log line, or a return value other than the `get` that asked for it.

## Design in one screen

| Piece | Choice |
|---|---|
| Backends | Native OS keyring (Keychain, Credential Manager, persistent Secret Service), explicit CLI keyring (`security` / `secret-tool`), passphrase file (scrypt + `sealSecretBox`), host-passed override map, Expo SecureStore and IndexedDB/WebCrypto. One secret per name. |
| Accounts sealing | `osKeyringSeal` stores random 32-byte data keys and an active id in the native keyring; `hostKeySeal` uses a separately provisioned host key. Versioned secretbox envelopes authenticate the header and app service. Rotation retains old keys; missing/damaged keys never regenerate on decryption. See README for the reviewed format, backup and migration limits. |
| Secret to keyring CLI | Stdin only, as raw UTF-8 bytes. Argv holds only `bin`, the verb, flags, service and name. Env holds only `PATH`, `LANG` and host-passed extras. |
| Keyring spawn | Absolute `bin` only (PATH is never searched); argv array, no shell; env passed explicitly so `process.env` is never inherited; per-call timeout (default 10 s) kills the process group (SIGTERM, SIGKILL 5 s later); stdout capped at 1 MB; stderr keeps a 2 KB tail for logs only, never in messages. |
| Passphrase file | `{ v: 1, kdf: 'scrypt-16384-8-1', salt: 16 fresh random bytes per save, box: sealSecretBox(JSON { entries }) }`. Atomic write: 0700 folders, 0600 temp file, rename. `openSecretBox` null → `auth-failed`, fail closed. Derived keys zeroed after use. |
| Phone | Optional Expo SecureStore peer; encoded names under an app prefix, consistent host-passed options on all calls; no plaintext simulator fallback. Platform errors are sanitized. |
| Web | IndexedDB persists a non-extractable AES-256-GCM key and versioned ciphertext with a fresh 96-bit IV. Entry names are authenticated as AAD. Key initialization is atomic across tabs; operations finish on transaction commit. |
| Override | A validated copy of the host's map. `process.env` never appears in `src/` (a test greps it out). |
| Errors | `KeystoreError` codes `invalid` / `auth-failed` / `unsupported` / `unavailable` / `failed`. Messages name the entry, never the secret. Missing entries resolve null/false, not errors. |

## Adversaries and what stops them

| Adversary | Can | Cannot, because |
|---|---|---|
| **Another user on the machine** | See that the app runs; see keyring entry labels (`byokit:<service>:<name>`) if the keyring exposes them | Read secrets: the keyring ACLs them to the person; the file is 0600 in 0700 folders. |
| **A process-listing observer** (`ps`, `/proc`) | See the CLI argv: bin, verb, service, name | See the secret: it travels on stdin only, never argv or env. |
| **Someone reading the sealed file** | Copy it, tamper with it | Open it without the passphrase (scrypt + secretbox); tampering fails closed with `auth-failed`. Offline passphrase guessing is bounded only by passphrase strength: the KDF is scrypt-16384-8-1, not a memory-hard giant. Apps must ask the person for a strong passphrase. |
| **A compromised environment** (poisoned `process.env`, decoy HOME) | Nothing through this kit | The kit reads no env var and inherits none into spawns; tests run it under a poisoned env and a decoy HOME with `--permission`. |
| **A malicious keyring CLI at `bin`** | Only what the host handed it: the app passes `bin`, so a hostile path is the app's own bug | The default bins are fixed absolute OS paths. |
| **Windows malware / another Windows user** | A privileged or same-user process can access unlocked credentials | Native Credential Manager protects keys under the OS user's policy; ciphertext-only leaks cannot decrypt. The legacy CLI backend rejects `unsupported` on Windows. No plaintext fallback. |

## Known limits

1. **Entry names are metadata.** The service and name appear in CLI argv and, for `secret-tool`, in the item
   label. They must not themselves be secrets.
2. **A secret ending in LF round-trips without it.** `get` strips the single trailing newline the CLI adds
   when printing. API keys never end in a newline; anything else should avoid one.
3. **Strings cannot be zeroed.** A string secret or passphrase leaves copies in the runtime. `Uint8Array`
   passphrases are zeroed where the kit owns the copy; derived keys always are.
4. **Two processes sharing one passphrase file can clobber each other.** Writes are atomic (readers never see
   half a file) but last-writer-wins; add a file lock if two writers ever share one file.
5. **No plaintext fallback, anywhere.** A missing keyring CLI is `unavailable`, a locked-out prompt the kit
   cannot answer is `failed`. The app shows words; the kit never retries a consent prompt.
6. **Native keyrings follow the host OS session.** The pinned binding may block or prompt for authorization.
   Missing/locked native storage rejects sanitized `unavailable`; Linux forces persistent Secret Service.
   The legacy CLI backend alone remains unsupported on Windows.

7. **Web origin access is powerful.** Non-extractability prevents exporting key bytes through WebCrypto;
   it does not stop same-origin scripts, XSS or browser extensions from asking that key to decrypt.
   Entry names remain visible metadata. Clearing/evicting storage loses the key and requires sign-in again.
8. **Native storage follows the app's OS policy.** Uninstall/backup/biometric changes can remove or invalidate
   entries; SecureStore payload limits vary by OS. The host configures Expo's plugin and authentication policy.
   Native delete is a read followed by a delete; concurrent callers may both return true.

## Review checklist

- [ ] `src/` contains no `process.env`; spawns pass `env` explicitly (never inherit).
- [ ] The fake-CLI tests assert the canary is absent from the recorded argv and env for set, get and delete.
- [ ] The poisoned-env test leaves behaviour unchanged and the fake's env holds exactly base plus host extras.
- [ ] A wrong passphrase rejects `auth-failed`; the sealed file holds no plaintext canary.
- [ ] `writeFileAtomic` creates 0700 folders and a 0600 file and replaces atomically (rename).
- [ ] Error messages name entries, never secrets; stderr tails never reach messages.
- [ ] Browser/React Native entries bundle and run without Node imports or globals; Expo is an optional peer.
- [ ] Fake IndexedDB tests prove encrypted storage, non-extractability, fresh IVs, tamper rejection and atomic key initialization.
- [ ] Fake SecureStore tests prove all methods use the same options and native errors cannot expose secrets.
- [ ] Accounts sealing tests prove fileStore integration, wrong-key/tamper failure without overwrite,
  retained rotation keys, key read-back and explicit host-key selection on headless servers.
- [ ] Real Secret Service testing runs only in a disposable OS session; ordinary tests use injected fakes.
