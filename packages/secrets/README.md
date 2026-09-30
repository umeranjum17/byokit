# @byokit/secrets

One secret per name for apps that hold API keys: `get/set/delete(name)`. Platform stores plus ready Node sealing adapters:

```ts
import { fileStore, keyringStore, overrideStore } from '@byokit/secrets';

// The OS keyring: macOS Keychain or Secret Service (libsecret).
const keys = keyringStore(); // { service?, bin?, tool?, env?, timeoutMs? }
await keys.set('openai', 'sk-…');
await keys.get('openai'); // 'sk-…' | null
await keys.delete('openai'); // true when an entry existed

// A passphrase-sealed file, sealed with @byokit/seal.
async function saveToFile(passphrase: Uint8Array) { // supplied by the person through the host app
  const file = fileStore({ path: '/home/app/data/keys.json', passphrase });
  await file.set('openai', 'sk-…');
}

// CI: the host builds the map from process.env itself; the kit never reads it.
const ci = overrideStore({ openai: process.env.OPENAI_API_KEY ?? '' });
```

The default Node entry requires Node 22.18+. Browser and React Native conditions select portable
entries with no runtime Node imports. Explicit entries are `@byokit/secrets/node`,
`@byokit/secrets/web` and `@byokit/secrets/native`. All entries export `Keystore`, `KeystoreError`
and `overrideStore`; platform backends are exported only on their platform.

```ts
// Web / PWA (also available from the main entry under the browser condition).
import { webStore } from '@byokit/secrets/web';
const web = webStore({ database: 'my-app-keys' });
await web.set('openai', 'sk-…');

// React Native (also available from the main entry under the react-native condition).
// Install the optional peer in the host app: npx expo install expo-secure-store.
import { nativeStore } from '@byokit/secrets/native';
const phone = nativeStore({ prefix: 'my-app' });
await phone.set('openai', 'sk-…');
```

## Backends

**Native OS keyring** (`osKeyringStore({ service })`). macOS Keychain, Windows Credential Manager and
Linux Secret Service through the optional, exactly pinned `@napi-rs/keyring` 2.1.0 N-API binding.
The synchronous form `osKeyring({ service })` implements `KeyringBackend` for sealing; the store form
implements the common async API. The binding loads only on an operation. Linux explicitly requires
`{ linux: { store: 'secret-service' } }`: no fallback to a kernel keyring that disappears on reboot.
An absent/locked service or missing native binary throws `KeystoreError` with `code: 'unavailable'`.
Only an actual absent entry returns null/false. Unsupported OSes throw `unsupported`.
Names, service and values are validated before native calls; native errors are sanitized.
Unlike the CLI backend, values ending in LF are preserved.

**OS keyring** (`keyringStore`). macOS Keychain through `/usr/bin/security`, Secret Service through
`/usr/bin/secret-tool`, each spawned by absolute path. The secret reaches the CLI only on stdin, never in
argv or env; every spawn gets an env built from nothing (`PATH`, `LANG`) plus only what the host passes in
`env` (on Linux that is where `DBUS_SESSION_BUS_ADDRESS` goes). `get` strips the single trailing LF the CLI
adds when it prints a secret, so a secret ending in a newline round-trips without it. Windows Credential
Manager is unsupported in v1: on `win32` every call rejects `unsupported`.

**Passphrase file** (`fileStore`). The whole map lives in one JSON file
`{ v: 1, kdf: 'scrypt-16384-8-1', salt, box }` where `box` is `sealSecretBox` over the entries under a
scrypt key, with a fresh 16-byte salt per save. Writes go through the exported `writeFileAtomic` (0700
folders, 0600 file, rename over the target). A wrong passphrase rejects `auth-failed` and fails closed:
nothing is returned and nothing is written. Prefer a `Uint8Array` passphrase: a string cannot be zeroed
because the runtime keeps copies; derived keys are zeroed after use.

**CI override** (`overrideStore`). A validated copy of the map the host passes; `get/set/delete` work on the
copy. In CI the host builds it from `process.env` itself — the kit never reads the environment, so a
poisoned environment cannot change what the kit does.

**Phone** (`nativeStore`). Calls Expo SecureStore's async get/set/delete methods. The optional
`expo-secure-store` peer loads on the first operation; importing the entry does not load native code.
A host can supply `secureStore` with the same three methods for tests or another compatible secure
backend. `options` passes SecureStore's `keychainService`, accessibility, authentication and access
options consistently to every call. Native failures reject with a sanitized `failed` error; a missing
peer rejects `unavailable`. There is no simulator plaintext fallback. Names are encoded as fixed-width
UTF-16 hex under `prefix` (default `byokit`) to satisfy Expo's key alphabet without collisions.
SecureStore can reject large values even below the kit's 1 MiB limit; authentication-protected values
can become inaccessible after biometric changes. See [Expo's installation and persistence guide](https://docs.expo.dev/versions/latest/sdk/securestore/).
Native delete reads before deleting; concurrent callers may both report true.

**Web** (`webStore`). Requires a secure browser context (HTTPS or trustworthy localhost), IndexedDB
and WebCrypto. `database` defaults to `byokit-secrets`; use a distinct database per app on a shared
origin. The `wrapped` object store holds a structured-cloned non-extractable AES-256-GCM key under
`device-wrap-key`, and versioned ciphertext under `item:<name>`. Each set generates a fresh 12-byte IV;
the JSON-encoded entry name is authenticated as additional data. Secret values are also JSON-encoded
to preserve every JavaScript string, including unmatched UTF-16 surrogates. Initialization chooses/inserts the key in one
readwrite transaction, so concurrent tabs keep one key. Writes resolve only after transaction commit;
delete checks existence and removes the entry in one transaction. Tampered ciphertext, swapped entry
names and invalid keys reject `auth-failed`. Browser storage/crypto failures reject with sanitized
errors; there is no plaintext fallback. Injectable `indexedDB`, `crypto` and `isSecureContext` options
are for fake-only tests. No key is cached after an operation: clearing origin storage requires sign-in
again. This protects ciphertext at rest, **not against same-origin scripts or XSS**, which can use the
stored key to decrypt. Browser profile copying and storage eviction remain browser/OS concerns.

Existing product stores are not imported automatically. To migrate, the host reads each entry through
its old store, sets it through this API, verifies it, then removes the old entry. Native names and web
ciphertext have kit-owned formats, so pointing at an old app's database is not a migration.

## Errors

`KeystoreError` with `code`: `invalid` (bad name, secret, path, passphrase or options — messages name the
entry, never the secret), `auth-failed` (wrong passphrase/key, tampered file or web ciphertext/key), `unsupported` (Windows CLI keyring
or unsupported native OS), `unavailable` (missing/inaccessible native keyring, CLI, host key, Expo peer or browser APIs), `failed` (anything else: platform
errors, timeouts, oversized output, unreadable files). Missing entries are not errors: `get` resolves null and
`delete` resolves false.

## Seal accounts files on desktop

```ts
import { fileStore } from '@byokit/accounts';
import { osKeyringSeal } from '@byokit/secrets/node';

const seal = osKeyringSeal({ service: 'Umer-desktop' });
const accounts = fileStore('/app-owned/private/accounts.bin', seal);
// Or directly: fileStore(path, osKeyringSeal({ service: 'Umer-desktop' })).
```

Use the app's own absolute path, with a private 0700 parent directory. Accounts 0.8.0's actual seam
is `fileStore(path, adapter)`; the adapter synchronously implements `encryptString/decryptString`.
Run this in Node or Electron's main process. Native calls may block or trigger OS authorization UI;
keep them off renderer/request latency paths. Each service must be unique to an app/security context.
`osKeyringSeal` tries non-interactive OS keyring access when constructed. If available, it creates a
random 32-byte data key on the first write and stores it in the OS keyring. If the service is absent,
locked or unresponsive, it automatically uses the persistent host-key file described below.
`seal.mode` reports `'keyring'` or `'host-key-file'`; `hostKeySeal().mode` is `'host-key'`.
Pass `fallback: false` when the keyring is mandatory. Once a file key exists, it remains the mode
for that service even if a keyring becomes available later; changing modes requires migration. Provider credentials remain in the sealed accounts file.
Automatic keyring selection runs operations in a short-lived helper with a 1000 ms timeout
(`timeoutMs`, 100–5000 ms). Key material travels over private stdin/stdout pipes, never arguments or
child environment variables. Linux uses an exactly pinned D-Bus client and the existing session bus:
no service activation, collection creation, Unlock or Prompt calls. Locked items and collections fail
closed. It reads only `DBUS_SESSION_BUS_ADDRESS` for that session (otherwise the standard user bus).
Windows uses the native Credential Manager backend. The pinned macOS native binding cannot suppress
authorization UI, so automatic selection uses the file key there; explicit `osKeyring()` remains
available to hosts that permit interaction. Injected `keyring` backends must themselves be bounded
and non-interactive. The kit never configures or unlocks the person's keyring.

The envelope is `BKS1 | mode (1 byte) | key id (16 bytes) | sealSecretBox payload`, using
`@byokit/seal`'s XSalsa20-Poly1305 with a fresh 24-byte nonce. The encrypted payload repeats the
entire header and holds JSON `{ service, text }`; both header and app context are authenticated.
Version changes, wrong keys, truncation, tampering or lost/corrupt key entries throw `auth-failed`.
With `fallback: false`, missing native storage throws `unavailable`. There is no plaintext fallback
or replacement key generation during decryption. The native binding never sees the file's credentials.

`seal.rotateKey()` creates and verifies a fresh key, then activates it for subsequent writes.
Old keys remain in the keyring so previous files and backups still open. Each immutable key has
a random entry name, avoiding lost keys when two processes initialize/rotate at once; the last
active-id update wins. A failed activation may leave an unused key. Instances re-read the active
id on each write, so other processes pick up rotation. Rotation alone does not rewrite files:
rewrite through accounts while holding the host's writer lock, verify, then retire old backups.
To revoke an old key, the host deletes `byokit-seal-key-v1-<id>` through
`osKeyring({ service }).delete(name)` only after every file using it has been migrated or retired.
Deletion permanently prevents those backups from opening. The pointer is `byokit-seal-active-v1`;
never delete the currently active data key. File writers still require a host lock across processes.

### Binding choice and security review

We evaluated platform CLIs and native bindings. The existing CLI store remains available for
explicit host-controlled binaries/environments, but its interface is async and lacks Windows.
The maintained [N-API keyring binding](https://github.com/Brooooooklyn/keyring-node) supplies
prebuilt binaries for desktop architectures and direct native APIs without shell/argv secrets;
N-API avoids a per-Electron-version ABI rebuild. Its [platform dependencies](https://github.com/Brooooooklyn/keyring-node/blob/main/Cargo.toml)
use Keychain, Credential Manager and the same Secret Service protocol used by libsecret on Linux.
We pin 2.1.0, whose [Linux store-selection API](https://github.com/Brooooooklyn/keyring-node#linux-backend-selection)
lets us require persistent Secret Service. We reuse the kit's existing reviewed crypto primitive
instead of introducing another algorithm or implementing crypto. A missing optional binding on a native path fails
closed (automatic selection falls back to the file key); hosts must bundle its platform binary with Electron and keep `.node` files outside ASAR.

- Other local users: OS account isolation protects keyring data; accounts' private directories/files
  also limit access. Privileged attackers and malware running as the same unlocked user can ask the
  keyring to decrypt or inspect process memory; these adapters do not stop them.
- Leaked files and backups: ciphertext alone reveals length/version/key id, but no API key.
  Restoring it requires the original app service and retained OS keyring data (or the host key).
  Copying both keyring material and files can defeat this protection; OS backup policy is host-owned.
- Tampering fails authentication before accounts reads or writes a credential. Complete replay of an
  older valid file remains possible; this adapter supplies no rollback/freshness guarantee.
- Owned byte copies are zeroed after use; JavaScript strings, native copies and returned plaintext
  cannot reliably be erased. Never log keys, credentials or decrypted content.

Tests inject `keyring: KeyringBackend` and never use the owner's keyring. A real Linux test is opt-in
through `sh scripts/test-keyring.sh`, which clears the environment and creates a private HOME, XDG
tree, D-Bus and daemon control directory. The test asserts the bus is the private one and refuses
inherited desktop settings before any native call. Setting `BYOKIT_REAL_KEYRING` alone cannot
authorize a real test. Without an available Secret Service the opt-in test skips, unless CI requires
the provisioned service. CI runs the same isolated harness.
Unit coverage exercises accounts' actual fileStore, fresh nonces, rotation, wrong keys, lost keys,
metadata tampering, persistence failures and the explicit server path. macOS/Windows native runtime
qualification remains host/platform CI work; the native API wrapper is fake-tested on every platform.

## Servers and headless Node

`osKeyringSeal({ service: 'my-app' })` works without manual provisioning on headless installs.
`hostKeyFileSeal({ service })` selects the automatic file adapter directly. Both use 32 random
bytes from `crypto.randomBytes`, in a private 0700 directory with 0600 files (Windows installs and
checks an owner-only ACL through the platform ACL API and fails closed if that is unavailable).
Existing symlinks, foreign owners or group/world-accessible key files/directories are refused
with a clear error; the kit never silently fixes their permissions or replaces a damaged key.
Unique O_EXCL temporary files are fsynced before rename; first use publishes a complete directory
atomically, so racing processes keep one key. POSIX directories are fsynced too; Node does not
provide directory fsync on Windows.

The stable path is `<platform state dir>/byokit-<SHA-256 of service>/host-key/`. The state directory
is `XDG_STATE_HOME` (absolute) or `~/.local/state` on Linux, `~/Library/Application Support` on macOS,
and `%LOCALAPPDATA%` or `~/AppData/Local` on Windows. Use a stable service per app. `stateDir` can
override the platform state root, for example in tests; keep it separate from credential backups.
The `active` pointer names an immutable `<id>.key` file. Never delete or edit these manually.
The envelope uses mode 2 and authenticates the key id and service.

**Threat model:** a host key on the same disk protects sealed stores against copies, backups and
archives leaking **only when the key directory is excluded**. It does not protect against code
running as the same OS user, a whole-disk copy containing both key and store, or a privileged
attacker. Losing the key makes the stores unrecoverable. Host-managed keys can keep a stronger
separation by living in an external secret manager.

### Rotate an automatic host key

Stop the engine and hold the app's exclusive writer lock across all processes, adapter creation
and rotation. Supply every sealed store and retained archive using this service:

```ts
import { hostKeyFileSeal } from '@byokit/secrets/node';
const seal = hostKeyFileSeal({ service: 'my-app' });
seal.rotate(['/app/private/accounts.bin', '/app/private/auth-store.sealed']);
```

Rotation authenticates every input, durably saves a fresh key and a `rotation` journal, then
atomically rewrites each file. Only after all replacements are durable does it activate the new
key, remove the old one and remove the journal. It exposes no key bytes. An interrupted rotation
keeps the journal and enough keys to open both generations; subsequent encryption refuses until
`seal.rotate()` (no arguments) resumes the recorded transaction under the writer lock. Decryption
still works during recovery. Do not edit/delete the journal or change/restore the listed files
during recovery. Files omitted from the list, including old backups, become unreadable after
retirement. `rotateKey()` retains its existing keyring-only behavior; automatic file keys require
`rotate(paths)` so retirement cannot precede the store rewrites.

For an explicitly managed key, use `hostKeySeal`. The host supplies exactly 32 bytes from its
secret manager or an app-owned 0600 key file kept separately from the accounts data:

```ts
import { readFileSync } from 'node:fs';
import { fileStore } from '@byokit/accounts';
import { hostKeySeal } from '@byokit/secrets/node';

// Host provisions this raw 32-byte key separately, with 0600 permissions.
const seal = hostKeySeal({ key: readFileSync('/host-managed/keys/Umer.key'), service: 'Umer-server' });
const accounts = fileStore('/app-owned/private/accounts.bin', seal);
// A synchronous resolver is also supported:
// hostKeySeal({ key: () => hostSecretCache.current32ByteKey(), service: 'Umer-server' })
```

Async secret-manager clients must resolve/cache the key before building the synchronous adapter.
The adapter copies the host key per operation and zeroes its own copy; it never erases the host's
bytes. A resolver failure throws sanitized `unavailable`; an invalid key length throws `invalid`.
The host-key envelope uses the same authenticated format with mode 0 and a zero key id. It does not
carry a key version: rotation is a host-controlled migration, decrypting with the old adapter and
rewriting with the new adapter under the same writer lock. Retain old keys for backups as needed.
Keep the key outside any backup/exposure boundary that includes the ciphertext; leaking both
removes the protection. OS seals and host-key seals do not open each other's envelopes; switching
requires this same deliberate decrypt/rewrite migration.

## Threat model

See [SECURITY.md](SECURITY.md).
