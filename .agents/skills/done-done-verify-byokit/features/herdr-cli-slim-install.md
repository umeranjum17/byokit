# Herdr cli-only slim install and adopt socket env

A cli-only consumer app runs `npm install @byokit/herdr` and drives Herdr through `HerdrKit`/`cli`:
the install stays small (no `@byokit/pair`/sodium-native, no `@byokit/discover`/react-native-zeroconf
or its React Native peer tail, no `@byokit/relay`), and an adopt kit that names no session socket
never puts `HERDR_SOCKET_PATH` into a child env. Apps that serve a link install the optional peers
themselves and keep working.

## Sub-features

- `slim-install`: a packed-tarball install of `@byokit/herdr` brings only `@byokit/seal` and `ws` as
  dependencies; `@byokit/pair`, `@byokit/discover` and `@byokit/relay` are absent from the tree, and
  with them `sodium-native`, `react-native-zeroconf` and `react-native`.
- `cli-journey-slim`: on that slim install, a `HerdrKit` in own mode over the kit's stand-in Herdr
  starts, reports `connected` and answers `snapshot()` and a real `cli()` call.
- `link-peer-refusal`: importing `@byokit/herdr/link` on the slim install fails with the kit's typed
  error naming `@byokit/pair` and the `npm install @byokit/pair` line (not a bare module-not-found).
- `adopt-env-unset`: an adopt kit with `socketPath: ''` runs `cli()` with no `HERDR_SOCKET_PATH` key
  in the child env, while `HERDR_SESSION` and an explicit app env still pass through.

## How to get to it (user POV)

- Pack the built kit and its workspace dependency (`packages/herdr`, `packages/seal`), then in a
  throwaway dir `npm install <herdr.tgz> <seal.tgz>` — exactly what a cli-only consumer gets from npm.
- Drive it with a plain Node script: `HerdrKit` + `writeBinShim` from `@byokit/herdr`/`@byokit/herdr/testing`
  (own mode, `stateDir` under the scratch dir), a dynamic `import('@byokit/herdr/link')` for the
  refusal, and an env-recording bin for the adopt env journey (packages/herdr/README.md).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). No real Herdr, account or egress: the kit's stand-in
Herdr serves a real Unix socket under the scratch directory. The install itself needs the npm
registry for `ws`/`@noble/*` only.

- **Pack.** From the worktree root: `npm run build`, then `npm pack packages/herdr packages/seal
  --pack-destination "$scratch_dir"`.
- **Install slim.** In `"$scratch_dir/slim"`: `npm init -y && npm install "$scratch_dir/byokit-seal-0.3.0.tgz"
  "$scratch_dir/byokit-herdr-0.8.1.tgz"`. Assert with `ls node_modules`: `@byokit` holds only `herdr`
  and `seal`; `sodium-native`, `react-native-zeroconf`, `react-native`, `@byokit/pair`,
  `@byokit/discover` and `@byokit/relay` are all absent; print the entry count and du size.
- **Write the consumer.** `"$scratch_dir/verify-herdr-cli-slim.mjs"` run with `node` from the slim dir:
  - `cli-journey-slim`: `writeBinShim` (fake Herdr, socket under the scratch dir) → `new HerdrKit({
    mode: 'own', bin, stateDir, path })` → `await kit.start()` → state `ready`, `kit.snapshot()`
    lists workspaces, `await kit.cli(['--version'])` prints `herdr <version>` → `await kit.stop()`.
  - `link-peer-refusal`: `await import('@byokit/herdr/link')` rejects with
    `/needs the optional peer @byokit\/pair/` and names `npm install @byokit/pair`.
  - `adopt-env-unset`: write a `#!/usr/bin/env node` bin that dumps `process.env` to a file, run
    `new HerdrKit({ mode: 'adopt', bin, socketPath: '', env: { HERDR_SESSION: 'verify' } }).cli(['--version'])`,
    then assert the dump has no `HERDR_SOCKET_PATH` key and `HERDR_SESSION === 'verify'`.
  It exits non-zero on any mismatch.
- **Run and capture.** `feature=herdr-cli-slim-install; entry=@byokit/herdr; drive=(bash
  "$scratch_dir/verify-herdr-cli-slim.sh")` (a wrapper doing the pack, install, asserts and consumer),
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **slim-install shows.** The `node_modules` listing in the drive output: no pair/discover/relay/
  sodium-native/react-native lines, and the before/after counts if a baseline install was recorded.
- **cli-journey-slim shows.** `connected`, the snapshot's workspace list and the `herdr x.y.z` stdout.
- **link-peer-refusal shows.** The caught error message naming `@byokit/pair` and the install line.
- **adopt-env-unset shows.** `HERDR_SOCKET_PATH absent` and `HERDR_SESSION=verify` from the dump.

## Gotchas

- `npm pack` a workspace package runs its `prepack` (`tsc -b`), so build first; pack both `herdr` and
  its one workspace dependency `seal`, and install both tarballs together so npm resolves the local
  copies instead of the registry's.
- The consumer must run with `node` from inside the slim dir so `@byokit/herdr` resolves to the
  installed copy, never to a workspace symlink.
- The fake-Herdr socket path and `stateDir` must stay under the scratch dir (Unix socket length).
- `await kit.stop()` stops the kit's own spawned fake server in own mode; the `writeBinShim` bin is
  spawned by the kit, so no second stop is needed.
