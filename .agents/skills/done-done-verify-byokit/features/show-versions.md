# Show the running version

Every runnable BYOKit surface says which version it runs, so a person can tell the build under development from the
one in use. One helper labels it everywhere: `@byokit/usage/version` (`versionLabel`, `pairLabel`) and
`@byokit/usage/version/node` (`packageVersion`, which reads a `package.json`; pending `changes/*.md` fragments make it
`<version>+dev (dev build)`, a published install reads as its release, a semver pre-release says `(pre-release)`).

## Sub-features

- `cli`: `byokit-accounts`, `byokit-dictation-wer` and `write` print `<bin> <label>` for `--version` and as the first
  line of `--help`. `byokit-eval` (decide installs no dependencies) reads its package.json inline and prints the plain
  version, also above its usage error (exit 2).
- `pwa`: `examples/pwa` shows `byokit accounts <label>` at the foot of the home page; `serve.ts` reads
  `@byokit/accounts`' package.json when it bundles the page.
- `herdr-kit`: the phone page shows `App <label> · Host <label>`. The page's version is built in by
  `examples/herdr-kit/build-web.ts`, the host's comes over `example.setup`; when they differ (the computer was updated
  while the page stayed open) a hint says to update the older one and reload.
- `expo`: the main screen ends with `byokit example <app.json version> · @byokit/accounts <version>`; a Metro dev
  bundle says `(dev build)`, the release APK does not.

## How to get to it (user POV)

- `node packages/accounts/dist/accounts-cli.js --version` (and the same for each bin) after `npm run build`.
- `node examples/pwa/serve.ts 8080`, open it, scroll to the foot.
- `cd examples/herdr-kit && npm start -- --herdr "$(command -v herdr)"`, pair a phone, look at the foot.
- Open the Expo example and scroll to the end of the main screen.

## Driving it

- **CLIs and herdr-kit.** `feature=show-versions; entry=.agents/skills/done-done-verify-byokit/capture/show-versions.mjs;
  drive=(node "$entry")`, then SKILL.md Evidence's capture block (a heavy job: it runs the herdr-kit e2e). It runs every
  built bin's `--version` and `--help`, checks each line against that package's package.json (with `+dev (dev build)`
  while fragments are pending), shows decide's usage error with its version, then runs
  `examples/herdr-kit/e2e.test.ts` offline with `BYOKIT_EXAMPLE_RESTART_PROOF` and keeps `herdr-kit/versions-match.png`
  (App and Host match) and `herdr-kit/restart-connected.png` (host came back as 99.0.0: the mismatch hint). Exit 0.
- **PWA.** `node .agents/skills/done-done-verify-byokit/capture/review-evidence.ts --base origin/main --slug <slug>
  --screens home-footer`: before/after frames at the foot of the home page in light and dark, phone and desktop.
- **Expo.** On a task-owned emulator under the device/heavy locks and memory gate:
  `sh .agents/skills/done-done-verify-byokit/capture/expo-versions.sh <serial> <absolute-evidence-dir> origin/main`.
  It runs `examples/expo/e2e-android.sh` with `EXPO_VERSION_EVIDENCE`: the base App's foot (`before__<theme>__foot.png`),
  then the candidate release APK, which must show the label read from `app.json` and `packages/accounts/package.json`
  (`after__<theme>__foot.png`), light and dark.
- **Offline tests.** `sh scripts/test.sh packages/usage/test/journey-version.test.ts packages/accounts/test/cli-command.test.ts
  packages/write/test/journeys-cli.test.ts examples/pwa/pwa.test.ts examples/herdr-kit/e2e.test.ts`.

## Gotchas

- A workspace build is a dev build while any `changes/*.md` fragment is pending for that package; after a release
  compiles the fragments the same build reads as the release.
- The herdr-kit screenshots show the e2e's scratch folder in the "Folder on the computer" field: that is the test's
  own `--folder`, not a person's path.
