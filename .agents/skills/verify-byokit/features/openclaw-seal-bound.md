# OpenClaw auth-store seal bound

Verification recipe for the [auth-store seal bound](../../../../packages/openclaw/README.md#retained-home-killed-without-stop): a large engine home can never abort the process at seal time. Regenerable tool caches never reach the sealer however large they are (including across a host killed without `stop()`), the sealed snapshot holds only credential files bounded by a fixed cap, and an over-cap store refuses with a typed error that carries the size and the cap; the last good saved store is kept as it was, no live file is deleted, and housekeeping such as archive retirement may still run.

## Sub-features

- A host killed without `stop()` leaves live plaintext trees plus a stale lock; the next `start()` reseals only credential state ( caches on disk are left in place, never sealed, never read).
- A credential file larger than the 1 MiB envelope chunk round-trips byte for byte (single-pass seal envelope).
- Credential state over the fixed cap rejects with exported `AuthStoreSealSizeError` (`code: 'auth-store-seal-size'`, fields `size`, `cap`), `{ phase: 'failed', why: 'auth-store-seal-size', sealSize }` and recovery words giving the size and limit in MB; the last good saved store is kept as it was, no live file is deleted, and housekeeping such as archive retirement may still run.

## How to get to it (user POV)

Start the kit against a home whose engine tool caches grew large; if a host crash skipped `stop()`, the next start recovers the sign-in itself. A home whose credential state itself exceeds the cap fails with a clear error naming the size and cap instead of aborting; do not move or delete files to get under the limit; report it.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer shipped in `capture/openclaw-seal-bound.mjs` from the worktree root. It needs the evidence directory (argv[2], inside the worktree) plus an absolute task-private scratch root (argv[3]; keep Unix socket paths short, never `/tmp`):

```bash
feature=openclaw-seal-bound
entry=.agents/skills/verify-byokit/capture/openclaw-seal-bound.mjs
drive=(node "$entry" "$evidence_dir" "$HOME/.cache/fm-scratch/<task>/openclaw-seal-bound")
```

Use SKILL.md's Evidence capture block after allocating `evidence_dir`. The consumer imports only built public entries (`@byokit/openclaw`, `@byokit/openclaw/testing`, `@byokit/secrets`), uses a synthetic `hostKeySeal` key and a `fakeGateway` transport (no engine install, no provider, no egress), and kills a real child process holding the store to produce the authentic stale-lock recovery. The sparse cache tree stays hole-only, so the drive is light; the credential marker is a synthetic Umer marker, never an owner credential.

## Gotchas

The killed-host leg spawns a child that must resolve the same built packages as the parent: the consumer writes the child script into the evidence directory (inside the worktree) so bare `@byokit/*` imports resolve, and passes the synthetic seal key inline. Caches are created with `ftruncate` holes; asserting they still exist with their full sizes after stop proves they were never read or removed. The over-cap leg writes a 1 GiB sparse credential file, past the 128 MiB limit, and reads the limit from the typed error: sparse creation keeps it cheap because the collector refuses by `stat` size before any read. No changed app screen, theme or device UI; the typed error and words are public SDK output.
