# S1 immutable engine qualification

Executed 2026-10-02 on Linux, Node 24.21.0, with the whole-job home fd9 lock.

- **BYOKit implementation candidate:** `3ad8a341af0ded758c7f8912cf4cbb8e03d1132f`.
- **Upstream stock identity (NOT a BYOKit commit):** OpenClaw `2026.8.1`, commit
  `ea806575e6450e4d1efdfc72c19f04be982a1b9b`, exact tar integrity from `engine/package-lock.json`.
- **Packed kit:** `byokit-openclaw-0.5.1.tgz`, sha256
  `c03ad394c6f420c81e9e52edcf69f16579137430044795941956f15a8936426b`.
  Only the kit tarball was local; all consumer dependencies came from the registry.
- **Production patch set:** empty, id `4f53cda18c2baa0c`. No R1 opt-out or R4 ledger feature is implemented by S1.
- **Stock whole-tree manifest hash:**
  `d00cfaae348b32ce0bc9268cf60f5248f79233c29e7cb2b13dd532606fbb1d53`; root 0555, entry 0444.

## Actual checks

`npm run build`, `npm run check`, `npm test` passed. The real packed fixture ran with
its own short HOME/TMPDIR, a separate 1800-second acquisition allowance and a 900-second execution deadline:
`npm run smoke:pack -- --openclaw-engine --keep-openclaw-fixture`.

The production kit prepared twice, booted the real engine, answered `--version`, and completed one request to a
scripted loopback provider. No accounts, external model calls or npm publication were involved.

For the following lab checks, only the **owned consumer's** installed kit manifest was changed to two independently
hash-pinned comment-only edits. They are not shipped features. No namespace or process-inventory mock was used:

1. A separately `npm ci`-installed, unmarked stock Gateway and an immutable set-A Gateway stayed healthy while a
   second kit selected set B and then stock. The base and set-A full-tree snapshots remained identical.
2. Patched-only and unpatched-only drift were tested independently, with repeated prepare on the same stateDir.
   Each old damaged tree remained unchanged, while a new sibling was selected and the original Gateway answered.
3. Real `doctor --fix` ran after stopping only its exact owned set-A Gateway (stock refuses another SQLite schema
   writer). The final tree stayed identical, and the Gateway was restarted successfully.
4. Switching sets reached health through the real bridge/plugin startup path. Stock rollback selected the existing
   verified stock tree, with no install. Patched builds had a deliberately nonexistent `npmPath` to enforce offline cloning.
5. Two independent kit processes raced an absent set, booted the same winner and left exactly one final directory
   and no temporary directory.
6. All ten **original attached-client** health probes passed, alongside independent fresh real RPC probes. The old
   Gateway PID/startTime remained `845033` / `103508302`. This is not a health-only substitute for client continuity.

All owned Gateway/host processes stopped; the qualified private fixture was retained read-only for the other owners.
The fixture code is `packed-patches.fixture.mjs`; the OpenClaw CI job runs the same packed qualification.

## Measured cost

| Operation | milliseconds |
|---|---:|
| Cold registry install + full immutable preparation | 57251 |
| Repeat full-tree preparation | 750 |
| Set-A offline clone | 59063 |
| Set-B offline clone | 60797 |
| Stock rollback selection | 774 |
| Patched-only drift replacement | 79024 |
| Unpatched-only drift replacement | 55207 |

Native async copy/install and bounded file/directory fsync preserve responsiveness; full tree hashing still runs
on the host thread. The earlier synchronous candidate took 205–282 seconds during install/clones and dropped the
old attached client. Its original failures are preserved, not relabelled passes. The first doctor probe also refused
an active schema writer; the final fixture stops only its own writer before doctor.

## Durable private receipts and limits

The task-private `.task-evidence/` contains the original source snapshots and raw command output:

- `packed-immutable-first.log`: sha256 `03831ba87fb14cde6a0246e8c1b39f4ff45bb7bf2cb8c3fa26a846d59badbd90`.
- `packed-immutable-second.log`: sha256 `0ebcade46fbfcc45f8fef89028535a983291de735f0f4766e0341cca841f4b51`.
- `packed-async-first.log`: sha256 `ae31c05223cfd490073749f72ac8050009ebf5370c5d3ce3eedb2baf1fb1d34b`.
- Original queue exit-75/no-start receipts and pre-correction source are retained too.

This verifies an owned packed candidate, not a published npm consumer, Mac/device behavior, R1 semantics or R4 billing.
After source integration, fresh exact-head CI is required; the earlier artifact hash must never be presented as the
newly integrated tarball's hash. Existing final sets are never garbage-collected or repaired in place.
