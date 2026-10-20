# Fresh-project pack gate

A brand-new consumer app outside the monorepo installs the packed `@byokit/*` tarballs from `npm pack` and imports, typechecks and runs them — the shape users actually receive from the registry. `scripts/pack-smoke.ts` owns this gate.

## Sub-features

- `pack-shape`: every workspace packs with required metadata and without source, tests or build-info files.
- `pack-install`: a scratch app outside the monorepo installs the tarballs.
- `pack-run`: the installed packages import and run.

## How to get to it (user POV)

- The maintainer runs `npm run smoke:pack` before a release; CI runs it on PRs.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); the heavy lock held for the whole run (installs + builds).

- **Run the gate.** `feature=pack-fresh-project; entry=scripts/pack-smoke.ts; drive=(npm run smoke:pack)`, then run SKILL.md Evidence’s capture block. Exit code `0`.
- **What it proves.** The script packs every workspace tarball, creates a scratch app outside the monorepo, installs the tarballs into it and proves the packed shape imports, typechecks and runs; it exits 1 on any failure.
- **Proof.** The captured artifact contains the script’s success lines and ends with `EXIT=0`; the scratch app is the script's own and it removes it (including on abort — it kills only gateways it owns, by pid).

## Gotchas

- Heavy: full pack + install + typecheck of every package. Do not run concurrently with other builds/tests in this home.
- On SIGINT/SIGTERM, the script kills only packed-gateway processes in its own run directory whose `gateway.pid`/`gateway.identity` match the live process; never kill by process name to "help" it.
- SIGKILL bypasses cleanup. The script does not scan or recover scratch directories from previous runs; do not claim those leftovers were cleaned by a later run.
