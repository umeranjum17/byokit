# OpenClaw kit security

## Scope and trust boundaries

This is the credential and approval threat model for `@byokit/openclaw`, reviewed
against engine **2026.8.1** on **2026-09-30**. The authoritative runtime design is
[runtime-kits.md](../../docs/runtime-kits.md), especially §§4.2, 5.5–5.9 and 7.1–7.3.
This review covers the kit's supervisor, migration, transport and sealed approval
path, including the credential-store lifecycle in kit 0.3.0; it is not an independent audit of the engine or its transitive dependencies.

The host app, its member mapping, configuration, plugin allowlist, tools and chosen
executables are trusted. The app must give each installation a private, app-owned
`stateDir`, with one writer, and protect its parent directory from other users.
An explicitly supplied `engineDir`, retained-login path and install-policy roots
are also trusted app choices. Untrusted inputs include model output, tool requests,
paired devices and relay/push payloads. Members separate application accounts;
they are not operating-system sandboxes within the shared engine process.

The kit protects against accidental discovery of another tool's credentials,
unauthorized device operations, wrong-member approvals and disclosure of approval
content to the relay. It cannot protect credentials from root, another process
running as the app's user, a compromised host/engine/plugin, or readable backups.
The isolated environment and tool gate are not an OS filesystem/network sandbox.
The app must sandbox `ToolHost.call` and judge requests in `ToolHost.gate`.

A locked or unresponsive keyring leaves the sealed snapshot unchanged. `prepare()` and `start()`
resolve with `phase: 'locked'`, do not restore plaintext or launch the engine, and a later start
retries after unlock. Opt-in dual wrapping opens through an owner-only host key without prompting;
its protection is only as strong as that file, which must stay outside sealed-store backups.
Unlocked keyring-only snapshots upgrade atomically under the store's exclusive lock after verifying
the replacement decrypts to identical contents. Other sealing failures still reject.

## Secrets at rest and in memory

| Asset | Location relative to `stateDir` | Protection and consequence of theft |
|---|---|---|
| Gateway token | `openclaw/token` | Random 32-byte bearer secret; newly created file is 0600. Treat it as operator access. |
| Device identity | `openclaw/device.json` | Ed25519 private key stored as **unencrypted PKCS#8 PEM** in JSON, newly created 0600. The transport accepts both kit and legacy paired shapes without rewriting. Theft can impersonate the operator identity. |
| Provider profiles | `openclaw/state/` and `openclaw/home/`, including agent/shared SQLite databases, journals and migration JSON | Access/refresh tokens or API keys are **plaintext while running**; without `authSeal` they also remain plaintext while stopped. Migration stages `auth-profiles.json` at 0600 in a newly created 0700 directory. Theft may authorize provider calls and refresh. |
| Sealed credential snapshot | `openclaw/auth-store.sealed` and retired `*.sealed` archives | With host-injected `authSeal`, authenticates and encrypts the complete state/home trees while stopped. Key security belongs to the adapter/host; an older authentic snapshot can be replayed. |
| Saved configuration, logs and sessions | `openclaw/openclaw.json`, `logs/`, engine state | May contain app-supplied keys, prompts, tool inputs, sign-in URLs/codes or provider diagnostics. Treat the whole tree as secret. Engine stdout/stderr is appended to a newly created 0600 log; it is not a guaranteed credential-redaction layer. |
| Notice seed and decrypted approvals | Device app storage and memory | The app stores the 32-byte seed; the kit receives it only for key derivation/decryption. Seed theft exposes notices for its box key. |

New supervisor directories use 0700 and new secret files use 0600. These creation
modes alone do **not** repair all pre-existing permissions, reject every symlink,
encrypt disk contents, or enforce Windows ACLs. The optional credential snapshot
collects regular files and file symlinks whose fully resolved targets are regular
files within the isolated engine root; links restore as regular files at the link
paths. Outside-root, dangling and directory links, sockets, FIFOs and devices are
skipped without reading their contents. Collected POSIX modes are normalized;
other paths still need host protection. Skipped entries are not preserved in the
snapshot and are removed with the live trees after successful sealing. Never use a shared/writable tree or point
the kit at another product's state. Review existing permissions before adopting a
tree; use an OS-protected app directory, encrypted disk and restricted backups.
Do not log `doctorContext().env`, transport arguments, auth records or sign-in
callbacks. JavaScript strings and engine memory are not reliably zeroized.

The engine needs plaintext credentials and PEM during operation. With `authSeal`
(a host-injected `SealingAdapter` from `@byokit/secrets`), `src/auth-store.ts` seals
all of state/home, including SQLite journals, on successful `prepare()` and after
the engine exits on `stop()`. It verifies the adapter round-trip, writes via an
exclusive temporary file, fsyncs/renames the snapshot and verifies it again before
removing live plaintext. `start()` authenticates and validates snapshot paths before
restoring files. Missing/wrong keys or tampering reject without plaintext fallback.
A live store owner or orphan gateway prevents a second kit from racing its writer.

This protects stopped stores, not a running engine or doctor. Await `stop()` on
orderly shutdown. An abrupt host exit can leave live plaintext; the next prepare
seals leftovers only after the orphan writer has exited. Interrupted restore or
removal recovers from the authenticated snapshot. A sealing failure retains
recoverable files and rejects; the host must resolve it and retry. Snapshot size
and memory cost grow with the complete state/home trees. Keys, gateway token,
device PEM, inline config secrets, logs, install/cache files and app workspaces
are outside this seal. OS-keyring or host-key adapters must keep the key separate
from state/backups. There is no rollback protection. File removal cannot erase old
blocks, snapshots, swap or backups. A sealed approval provides separate transit
confidentiality and does not seal the credential tree.
After suspected compromise, revoke provider credentials with the provider, stop
the app's own engine, revoke device grants and recreate its operator identity and
token in a fresh private state directory. Deleting files alone does not revoke
already copied credentials or erase snapshots/backups.

## Engine isolation and installation

`src/engine.ts` builds the gateway/doctor environment explicitly: HOME, XDG,
provider-tool homes, tmp, config and state paths point into the app's tree. It does
not forward shell API keys, `NODE_OPTIONS` or shell environment snapshots. The
gateway binds `127.0.0.1` on its own port, uses token authentication and a signed
device identity, and disables Control UI, discovery, channels, automatic updates
and default remote memory search. Loopback is a reachability restriction, not a
substitute for authentication against other local processes.

Installation is a separate boundary: `npm ci --ignore-scripts` consumes the
committed engine lockfile, verifies the exact engine version, and uses an isolated
install HOME/cache. It needs the registry/network once and inherits the host PATH
to find npm; `npmPath` and `enginePath` must resolve to trusted executables. Version
and integrity pins reduce drift, but do not prove dependency safety. Trusted app
config can add plugins, providers and other destinations. The kit is not a
general egress filter. Builtin tools are gated by default; `gateBuiltins: false`
weakens that boundary deliberately. The install policy refuses dependency
installs, and trusted skills/roots remain the app's responsibility.

## Retained-login migration

`src/migrate.ts` reads only the explicit `{ path }` or `{ record }` supplied by the
app. It never searches HOME for credentials. Member ids are validated before
writing. Before the gateway starts, it stages legacy profiles in the member's
own profile store, then runs the offline doctor to canonicalize them. An existing
profile store is not overwritten; a failed doctor removes only staging this call
wrote. Tests exercise these conditions and path traversal refusal.

With `authSeal`, offline migration restores the credential snapshot and reseals
the staged/imported store even after a failed doctor. The public `doctorContext()`
escape hatch does not enforce that lifecycle; use the kit migration method.
A zero doctor exit is insufficient to retire a login. Only a gateway status report
that every expected provider is signed in confirms migration. Confirmation removes
the explicitly supplied path and its retained plaintext/sealed copies, then writes
an empty `<path>.moved-to-engine.canonicalized` marker. No new plaintext retained
archive is created. A record source remains the app's responsibility to delete.

Prepare scans only the app-owned tree for engine migration archives and old retained
copies, excluding install/cache/tmp/plugin/workspace roots and symlinks. With an
adapter these become verified `*.sealed` archives; without one, engine archives and
confirmed retained copies are removed. An unconfirmed retained copy stays available
for migration unless sealed. A sealed archive is not restored as live engine input;
an unconfirmed sealed retained source can be read by explicitly passing its original
path and the matching adapter. External sources are handled only when the host
explicitly supplies them. Archive log events contain no credential bytes.

Protect the original directory and backups; cleanup neither revokes credentials nor
erases historical copies. Never pass an owner's unrelated auth file or run concurrent
migrations. Staging uses a predictable pid suffix and a rename; hostile directories
remain outside the trusted-directory contract. The sealing store's ownership and
symlink checks do not establish an OS sandbox or general protection for other paths.

## Approvals, devices and relay notices

The bridge denies unknown runs and gates every tool by default. Registered app
tools use single-use permits or tickets bound to session, tool and exact input;
run teardown discards their authorizations. Missing/failed gates deny. Parked
asks expire, deny when the caller disconnects, and are removed on shutdown.
Native exec/plugin decisions use `allow-once`, not a persistent allowlist.
The engine remains authoritative for native approval expiration and resolution.

`openclawLink` checks the app's member mapping and session prefix before member
operations, checks pending approval ownership before deciding, and denies mutation
to view grants. Raw `oc.call` is denied unless the app's `passThrough` explicitly
allows the method; that callback must also enforce parameter/member scope. The
local `kit.call`/`kit.decide` surface has operator authority and is trusted host
code. Unattributed approvals never match a valid member id.

Notice registration sends only a 32-byte box public key over the authenticated
device link. `sealNotice` encrypts the complete approval with `@byokit/seal`'s
sealed box; each device receives separate ciphertext. A device with no registered
box key gets only the generic title. The relay sees destination, approval id,
generic title, action labels, timing, urgency and ciphertext size; it does not
need approval plaintext. Wrong keys, altered ciphertext, invalid JSON, versions
and approval shapes are rejected by `openNotice`.

Sealed boxes do **not** authenticate the sender: anyone with the public key can
encrypt a notice. They also provide no freshness/replay check; timestamps are
data, and a notice is never authorization. Treat it as a prompt to reload current
approvals over the authenticated link. `onAction` checks a remembered grant,
current member mapping, control authority, allow/deny action and pending member
approval. The relay action transport must authenticate the device and reject
replays before invoking it; a caller-supplied device id is not proof. Grant
revocation must make `memberOf` return undefined for revoked grants, since the
adapter retains grants/box keys seen earlier. Push failures do not resolve asks.

## Review record and regression evidence

Review completed 2026-09-30 by source inspection and offline regression coverage:

- [x] Plaintext identity/profiles, creation modes, logs, backup and same-user risks documented.
- [x] Shared isolation contract (`test/isolation-contract.ts`) runs in `npm test`
  through `test/isolation.test.ts` with an offline child, exercising the actual
  Engine spawn, its received environment/cwd, loopback listener, creation modes,
  safe config and unchanged decoy HOME files. It checks its log for the token,
  private PEM and inherited key canary; this is not a universal log-redaction proof.
- [x] `test/engine/isolation.test.ts` runs the same contract against the pinned
  engine in `npm run test:engine` / CI's `openclaw-engine` job. It requires a
  registry install; the default test run remains offline. Neither test claims
  complete syscall tracing or an OS sandbox.
- [x] Migration failure, existing profiles, private staging, member validation,
  confirmation and verified-source removal covered by `test/migrate.test.ts`.
- [x] Optional credential sealing, wrong keys, tampering, concurrent owners, safe file-link
  materialization and skipped runtime/unsafe entries, interrupted transitions and archive cleanup covered by
  `test/engine-unit.test.ts`. The seal excludes gateway/device secrets and live state.
- [x] Bridge fail-closed, timeout/disconnect and one-use input binding covered by
  `test/bridge.test.ts` and `test/plugin.test.ts`.
- [x] Member/role checks, sealed/generic relay content, wrong-member push refusal
  covered by `test/link.test.ts`; wrong-key and ciphertext tampering rejection
  covered by `test/device.test.ts`.

The review found that a remembered **view** grant could resolve an approval via
`onAction`, although `oc.decide` already refused it. The push path now applies the
same role restriction, with a same-member view-grant regression case. The risks
above remain explicit limits; optional stopped-store encryption does not claim
live credential confidentiality or general hostile-directory safety.

Report a suspected vulnerability privately through the repository's GitHub
security advisory channel when available. Do not put tokens, private keys,
retained login files, pairing grants or unredacted logs in a public issue.
