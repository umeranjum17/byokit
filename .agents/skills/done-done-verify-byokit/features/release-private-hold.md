# Deprecated kits held back with `private: true`

A package that has moved to another home (`@byokit/record`, `overlay`, `statusbar`, `browser` and
`bubble` live on as `@platform-kits/*`) takes no further version under its old name. `private: true`
is the release tool's own hold: `scripts/release.ts` publishes `workspacePackages().filter((p) => !p.isPrivate)`,
so a held name is never in the pending set, is never attempted, and cannot fail a publish the way a
missing trusted-publisher relationship did. Being private also exempts the package from the
decreased-version lint rule, so holding it back weakens no guard.

## Sub-features

- `held-never-attempted`: `npm run release -- publish --dry-run` on a tree where those five are
  private lists only the versions that still need publishing; none of the five appears in the gate
  list or in any `npm publish -w` line.
- `others-unchanged`: the versions that still belong in `@byokit` keep exactly the version and pin
  they had; `package-lock.json` and every other lockfile are byte-identical to before the hold.
- `pack-still-works`: publish's `smoke:pack` gate is unaffected, because `npm pack --workspaces`
  still packs a private workspace package.
- `lint-passes`: `npm run release -- lint --base origin/main` is green, with one `## Unreleased`
  bullet per held package naming its new home.

## How to get to it (user POV)

- A release merged 27 versions; publishing stopped on a package whose old name no longer has a
  trusted publisher. After this hold, the next publish run attempts only the names that still belong
  in `@byokit` and never touches the deprecated ones again.

## Driving it with the release tool itself

Preconditions: worktree root of the branch under test, `npm ci` done, tree committed and clean.

- `npm run release -- publish --dry-run` — the real command the release workflow runs, minus the
  publish. Capture stdout and the exit code. Expected: the `would gate:` line and the `npm publish -w`
  lines name only packages whose version is not yet on npm; the held names appear nowhere.
- `npm run release -- lint --base origin/main` — exit 0.
- `git diff --stat origin/main -- package-lock.json examples/expo/package-lock.json` — empty.
- Extreme (a held name is named anyway): remove `private` from one held package and re-run the dry
  run; it reappears in the gate list, which is the state this hold removes. Restore it afterwards.

## Gotchas

- `private: true` blocks publishing, not packing or installing: workspace consumers and
  `npm pack --workspaces` keep working, so nothing else in the release gate needs a change.
- The hold is not a deprecation: the npm deprecation notice and the `@platform-kits` packages are
  separate, already-published facts.
- A held package's `CHANGELOG.md` still needs a bullet when its manifest changes (lint rule at
  `scripts/release.ts`), which is why each of the five carries one `## Unreleased` line.
