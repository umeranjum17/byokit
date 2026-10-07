# Accounts security

Review scope: accounts credential storage, sign-in failure logging, provider isolation and
portable platform boundaries, reviewed 2026-09-30. This is a source review with offline
regression tests, not an independent cryptographic audit or a live OS keychain certification.

## Assets and trust boundaries

OAuth access and refresh tokens, API keys, identity/plan claims, device sign-in codes and
callback state are sensitive. The host selects each member's store, provider offer and
platform adapter. The kit uses only those stores; it never imports another application's
credentials. The computer engine is exactly pinned in package.json and isolated from
ambient credential discovery. The Node entry has filesystem access; browser and React
Native entries exclude runtime Node and engine imports.

The provider and network are outside the storage boundary. OAuth sign-in sends codes and
tokens only to the configured provider endpoints over TLS in production. Host-supplied
endpoint overrides, adapters and fetch implementations are trusted code: production hosts
must not substitute untrusted endpoints. Callback state binds the loopback return to the
pending sign-in; a code or consent URL must be shown only to its intended member.

## At rest

`fileStore(path, adapter)` requires sealing. No encryption key is generated beside the
credential file and no plaintext fallback exists. Electron hosts pass safeStorage after
ready. When reported, unavailable encryption and the Linux basic_text backend are refused
at construction and on each operation. An equivalent adapter is trusted to use authenticated
encryption and keep its key outside this file, preferably in an OS keyring. An arbitrary
adapter can lie about sealing; this seam cannot certify the host's implementation.

New immediate directories are 0700; existing immediate directories must be real 0700
directories. Reads use O_NOFOLLOW, then inspect the opened descriptor for a private regular
file; nonblocking opens avoid waiting on a substituted FIFO. Writes seal before opening a
random temporary path with O_EXCL (wx) and O_NOFOLLOW, mode 0600, sync the file (except under Node's permission model, which disables fsync), then rename
it atomically. Cleanup removes only a temporary file this operation successfully created.
A legacy predictable .tmp path is never opened. Decryption and parse failures propagate;
corrupt or plaintext files are never replaced as an automatic recovery step.

The host must own the entire parent path and prevent concurrent directory replacement.
These POSIX checks do not resolve or pin every ancestor: malicious parent directories,
mounts, a process running as the same OS user, root, and compromised host code are outside
this boundary. Windows hosts must also configure private ACLs; POSIX mode bits and
O_NOFOLLOW are not a substitute for Windows access controls. Atomic rename avoids partial
records, but the directory is not synced: recovery after sudden power loss is not guaranteed.
Processes sharing a path take turns through a `<path>.lock` file beside it. Encryption does
not prevent deletion, rollback to an older sealed record, or leaking credentials in memory.

Browser IndexedDB is origin-scoped plaintext accessible to scripts in that origin. The host
must prevent XSS and untrusted scripts; a browser cannot promise OS-keychain protection.
React Native secureStore delegates protection and device accessibility policy to the
host's Keychain/Keystore adapter. memoryStore holds credentials only in process memory.
Host-defined recordStore persistence inherits the host backend's security properties.

## Logs, sign-out and isolation

Default sign-in and discarded-credential revoke diagnostics contain fixed messages only,
not raw provider errors, member identifiers, credentials, callback URLs or nested causes.
The host's onSignOutError callback receives the underlying error for handling: do not log
that error without sanitizing it. Other host-visible error/event payloads and model content
can also be sensitive; the kit does not redact arbitrary host logging or dump memory.

Sign-out attempts provider revocation and removes the local credential even on failure.
A generation check discards late sign-ins/refreshes so they cannot restore a signed-out
credential. Revocation failure means a copied token may remain usable at the provider.
Deleting local files alone does not revoke tokens, and deletion cannot erase old backups.

Tests use fake providers, temporary homes, filesystem canaries and Node permissions;
`npm test` blocks outbound networking and checks the owner's existing setup byte for byte.
The kit never borrows environment API keys. Its Node-only `./cli` exception invokes only app-passed absolute CLI binaries against app-managed folders; it never opens credential files or the person's default login. Native CLI credentials remain on the device under the CLI's own storage policy; they do not pass through `fileStore` sealing.

## Review record

- [x] Required sealing; unavailable and basic_text Electron backends fail closed, including
  availability changing after construction (`test/units.test.ts`).
- [x] Sealed credentials round-trip without plaintext access/refresh tokens on disk;
  existing sealed adapter format is preserved (`test/units.test.ts`).
- [x] Target and immediate-directory symlinks and permissive modes are refused; a decoy
  .tmp symlink is unchanged; encryption failure preserves the prior file and random temp
  files are cleaned after successful replacement (`test/units.test.ts`).
- [x] Sign-in and failed late-revoke logs use fixed messages, exercised with credential
  canaries in injected failures (`test/accounts.test.ts`, `test/revoke.test.ts`).
- [x] Revocation and late completion use offline fake-provider regression coverage
  (`test/revoke.test.ts`); isolation and portable imports retain their existing tests
  (`test/isolation.test.ts`, `test/portable.test.ts`).

Run `npm run build`, `npm run check` and `npm test` to reproduce the review checks.
Live Electron/OS keyring security and host adapter configuration remain the host's responsibility.

## Reporting and migration

Report a vulnerability privately through this repository's GitHub Security Advisories:
https://github.com/umeranjum17/byokit/security/advisories/new . Do not include live tokens
in an issue, logs, screenshots or a public reproduction. Include the package version,
platform, affected seam and an offline reproduction using synthetic credentials.

For legacy plaintext files, follow the README's migration: stop writers, revoke through
the old app, remove only the app-owned credential file and sign in again using sealing.
Previously sealed files need only the same adapter passed explicitly. There is no silent
plaintext migration and no recovery by replacing a file that fails to decrypt.
