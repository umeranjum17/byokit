# @byokit/keystore

One secret per name for apps that hold API keys: `get/set/delete(name)`. Three backends, one shape:

```ts
import { fileStore, keyringStore, overrideStore } from '@byokit/keystore';

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

Node 22.18+ only: it spawns keyring CLIs and uses `node:crypto` scrypt. There is no browser or React
Native entry. The package is `private: true` at 0.1.0: unpublished until the owner runs the release.

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

## Errors

`KeystoreError` with `code`: `invalid` (bad name, secret, path, passphrase or options — messages name the
entry, never the secret), `auth-failed` (wrong passphrase or tampered file), `unsupported` (Windows keyring
in v1), `unavailable` (the keyring CLI is missing or not executable), `failed` (anything else: CLI errors,
timeouts, oversized output, unreadable files). Missing entries are not errors: `get` resolves null and
`delete` resolves false.

## Threat model

See [SECURITY.md](SECURITY.md).
