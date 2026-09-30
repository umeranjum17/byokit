# @byokit/secrets

One secret per name for apps that hold API keys: `get/set/delete(name)`. Five backends, one shape:

```ts
import { fileStore, keyringStore, overrideStore } from '@byokit/secrets';

// The OS keyring: macOS Keychain or Secret Service (libsecret).
const keys = keyringStore(); // { service?, bin?, tool?, env?, timeoutMs? }
await keys.set('openai', 'sk-…');
await keys.get('openai'); // 'sk-…' | null
await keys.delete('openai'); // true when an entry existed

// A passphrase-sealed file, sealed with @byokit/seal.
const file = fileStore({ path: '/home/app/data/keys.json', passphrase });
await file.set('openai', 'sk-…');

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
entry, never the secret), `auth-failed` (wrong passphrase, tampered file or web ciphertext/key), `unsupported` (Windows keyring
in v1), `unavailable` (missing keyring CLI, Expo peer or browser APIs), `failed` (anything else: platform
errors, timeouts, oversized output, unreadable files). Missing entries are not errors: `get` resolves null and
`delete` resolves false.

## Threat model

See [SECURITY.md](SECURITY.md).
