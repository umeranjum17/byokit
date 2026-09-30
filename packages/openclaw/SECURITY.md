# OpenClaw kit security

## Scope and trust boundaries

This is the credential and approval threat model for `@byokit/openclaw`, reviewed
against engine **2026.8.1** on **2026-09-30**. The authoritative runtime design is
[runtime-kits.md](../../docs/runtime-kits.md), especially §§4.2, 5.5–5.9 and 7.1–7.3.
This review covers the kit's supervisor, migration, transport and sealed approval
path; it is not an independent audit of the engine or its transitive dependencies.

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

## Secrets at rest and in memory

| Asset | Location relative to `stateDir` | Protection and consequence of theft |
|---|---|---|
| Gateway token | `openclaw/token` | Random 32-byte bearer secret; newly created file is 0600. Treat it as operator access. |
| Device identity | `openclaw/device.json` | Ed25519 private key stored as **unencrypted PKCS#8 PEM** in JSON, newly created 0600. The transport accepts both kit and legacy paired shapes without rewriting. Theft can impersonate the operator identity. |
| Provider profiles | `openclaw/state/agents/<member>/agent/auth-profiles.json` | **Plaintext** access/refresh tokens or API keys, owned and refreshed by the engine. Kit migration creates the file 0600 in a newly created 0700 agent directory; subsequent engine writes belong to the engine. Theft may authorize provider calls and refresh. |
| Saved configuration, logs and sessions | `openclaw/openclaw.json`, `logs/`, engine state | May contain app-supplied keys, prompts, tool inputs, sign-in URLs/codes or provider diagnostics. Treat the whole tree as secret. Engine stdout/stderr is appended to a newly created 0600 log; it is not a guaranteed credential-redaction layer. |
| Notice seed and decrypted approvals | Device app storage and memory | The app stores the 32-byte seed; the kit receives it only for key derivation/decryption. Seed theft exposes notices for its box key. |

New supervisor directories use 0700 and new secret files use 0600. These creation
modes do **not** repair pre-existing permissions, reject every symlink, encrypt
disk contents, or enforce Windows ACLs. Never use a shared/writable tree or point
the kit at another product's state. Review existing permissions before adopting a
tree; use an OS-protected app directory, encrypted disk and restricted backups.
Do not log `doctorContext().env`, transport arguments, auth records or sign-in
callbacks. JavaScript strings and engine memory are not reliably zeroized.

The engine needs plaintext profiles and PEM to use its current storage/protocol.
This kit does not provide keystore-backed encryption for these files. A sealed
approval is encryption in transit, not encryption of this credential tree.
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

A zero doctor exit is insufficient to retire a login. Only a gateway status
report that every expected provider is signed in confirms migration. A path
source is then renamed to `<path>.moved-to-engine`, and a `.canonicalized` marker
prevents reimport. **The retained copy still contains plaintext credentials.**
The rename preserves its bytes and existing permissions; it neither seals nor
revokes them. A record source remains the app's responsibility to delete. Plan
private backup retention/cleanup after confirmation, including the original
directory, temporary staging and backups. Never pass an owner's unrelated auth
file or run concurrent migrations. Staging uses a predictable pid suffix and a
rename; hostile symlinks or concurrent writers in that directory are outside this
trusted-directory contract.

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
  confirmation and retained-byte behavior covered by `test/migrate.test.ts`.
- [x] Bridge fail-closed, timeout/disconnect and one-use input binding covered by
  `test/bridge.test.ts` and `test/plugin.test.ts`.
- [x] Member/role checks, sealed/generic relay content, wrong-member push refusal
  covered by `test/link.test.ts`; wrong-key and ciphertext tampering rejection
  covered by `test/device.test.ts`.

The review found that a remembered **view** grant could resolve an approval via
`onAction`, although `oc.decide` already refused it. The push path now applies the
same role restriction, with a same-member view-grant regression case. The risks
above remain explicit limits; at-rest encryption and hostile-directory safety are
not claimed as implemented.

Report a suspected vulnerability privately through the repository's GitHub
security advisory channel when available. Do not put tokens, private keys,
retained login files, pairing grants or unredacted logs in a public issue.
