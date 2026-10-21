# The upgrade journey: upgrade the shipped package in place

A person who already uses byokit's account package gets the next release the way every release reaches them: the new package is installed over the one they have, in the same app, and their app keeps working. The drive proves the whole path: the previous shipped version from the npm registry, the upgrade over that same install, then the core journey again on the upgraded package.

## Sub-features

- `upgrade-journey-previous`: the previous shipped version is the greatest published version under the one being built (`npm view @byokit/accounts versions`), and the drive names the registry tarball it installs.
- `upgrade-journey-install`: that previous version installs into a fresh app outside the monorepo and the core journey runs on it: the app links an account and gets an answer.
- `upgrade-journey-in-place`: the upgrade lands in the same app directory, over the same install: `npm install` of the packed tarball replaces the old package in place, and the installed version becomes the one being built.
- `upgrade-journey-core`: the core journey runs again on the upgraded package, in the same app, and answers the same way.
- `upgrade-journey-record`: the drive writes the transcript of both runs and the step record (`steps.json`) into the run's evidence folder.

## How to get to it (user POV)

- The person runs `npm install @byokit/accounts` in their app, and later `npm update @byokit/accounts` (or installs the next version) over that same app. Nothing else about their app changes: no reinstall, no new folder, no re-linking.
- Inside the app, nothing changes either: the same `Accounts`, the same store, the same calls.

## Driving it with node scratch consumers

- **Run the maintained capture.** `feature=upgrade-journey; entry=@byokit/accounts; drive=(node .agents/skills/done-done-verify-byokit/capture/upgrade-journey.mjs)`, then SKILL.md Evidence's capture block. Exit code `0`. As a done-done journey it is the `upgrade` journey in `.done-done.yaml`.
- **What the capture does.** It packs the workspace package, asks the registry for the previous shipped version, installs that version into a fresh app and runs the core journey's consumer app on it; then it installs the packed tarball over that same app and runs the same consumer again.
- **What the output shows.** `previous shipped version: @byokit/accounts@0.29.0 (https://registry.npmjs.org/@byokit/accounts/-/accounts-0.29.0.tgz)`, the first run's transcript with `package: @byokit/accounts@0.29.0`, `upgraded in place, over that same install: @byokit/accounts@0.29.0 -> @byokit/accounts@0.30.0`, then the second run's transcript with `package: @byokit/accounts@0.30.0` and the same `status: ChatGPT is connected.` and `answer: You said: Plan my day`.
- **The capture's own files.** `upgrade-journey.txt` (both transcripts) and `steps.json` (the step record) in the run's evidence folder.

## Gotchas

- The journey needs the npm registry: it installs the previous shipped version from there, the way a user does. The provider stays on loopback and no credential is read.
- The previous version is chosen from the registry at run time, so the drive keeps working after the next release; the transcript always names the version it used.
- The upgrade is `npm install` of the packed tarball over the existing install — the same `node_modules`, the same app directory — not a fresh install beside the old one.
- The core journey's consumer uses an in-memory store, so the sign-in is made again after the upgrade; what the drive proves is the package path, not the survival of an app's own data.
