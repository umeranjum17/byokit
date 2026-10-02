# Bridge signaling qualification (2026-10-02)

## Scope and reconciliation

The accepted foundation is `c1b7ba08`, based on `origin/main` `16f4c5a654dabc5fe11af5404bf0a902fc182ecf`.
A fresh fetch at implementation start found no intervening main commits or shipped adapter to drop.
The public registry still returns E404 for `@byokit/signaling`; published link/reach export maps do not expose
this adapter. The routed quickstart gap and the published receiver's `Signaling` contract remain applicable.

The new capability-named package has **zero runtime or BYOKit dependencies**. Its typed contract is structurally
compatible in both directions with published `@desklink/react-native@0.3.1`'s signaling and complete SessionEvent
union. Requests preserve all methods, wire parameters and result fields; the event mapper deliberately implements
the receiver's union rather than promising every raw host event. The package choice was accepted in the brief;
no naming or product decision is outstanding.

Read-only protocol sources: `@desklink/host@0.3.1`'s `docs/PROTOCOL.md`, `dist/bridge.js`, `dist/engineProcess.js`,
and `@desklink/react-native@0.3.1`'s `src/protocol.ts` and `src/useDesktopSession.ts`, from public npm tarballs.
The referenced inline example was read at upstream release commit `e8b8ae51`, path
`packages/desktop-client/example/App.tsx`. No upstream files were modified or patched.

## Executed evidence

- Clean `npm ci` after the workspace-only lock refresh; no unrelated dependency resolutions changed.
- Root `npm run build` and `npm run check` passed. The foundation's stale sibling-dist check failure cleared
  through the ordinary root build, not a weakened compiler configuration.
- Scoped README check and release lint passed without new baseline entries.
- Node **22.23.2**: source check and **33 scoped tests**, all passed, including 14 signaling tests and the
  existing pack-smoke, README and release tooling tests. Initial Node 26.7.0 focused signaling run also passed.
- `npm pack --workspace @byokit/signaling`: installed into `/home/umer/.bkt/bsg/app`, outside the repository,
  using the tarball and public npm dependencies only. No workspace aliases or private source installs.
- The README's **25-line App.tsx** typechecked strictly against the installed receiver. A separate contract
  check assigned both signaling and event unions in both directions and the full authorization session options.
- That App.tsx bundled with esbuild, including the installed adapter and receiver; React, React Native, Expo,
  expo-modules-core and native WebRTC were external. This is a JS bundle seam, **not** an Expo native build.
- The new pack-smoke entry ran against a mock loopback bridge through the installed export on Node 22.
- The same packed adapter ran against the **stock public host 0.3.1 and public Linux engine 0.3.1** on Node 22
  (also Node 26), in an empty environment with isolated HOME, openh264 disabled and an owned Xvfb. Passed:
  concurrent hello/capabilities, host-selected-source refusal (`source`), local-frame refusal (`operation`),
  unsupported protocol, wrong-token upgrade rejection (`transport`), and three fresh authorizations, including
  after explicit close. The stock Bridge and owned Xvfb were closed/reaped in finally, under the parent heavy lock.
- Mock tests additionally cover all six typed event variants, out-of-order ids, malformed/unmatched responses,
  close before open, pending-request rejection on error/close, callback cleanup, unsubscribe, stale-socket
  isolation and authorization after unexpected disconnect. The stock bridge does not forward restore tokens;
  only the mock proves that compatibility mapper member.

A first stock harness attempt failed because `resolveEngine()` returns `{command, args, origin}`, not a string.
The original log is retained; the harness was corrected to use the published API, without changing the host.
A registry hash helper also initially assumed npm's JSON output was an object; it was corrected to accept the
actual single-element array. The verified host/receiver tarball SHA-512 values match fresh public metadata.
A native-constructor type probe found that the foundation's contravariant event handlers rejected a real WebSocket
constructor override. Method-variant callback types now accept platform-specific event types without DOM imports;
the original compiler failure and the passing cast-free probe are retained. After that type repair, build/check,
all 33 scoped tests, packing, outside types/bundle and mock/stock runtime were rerun on the exact new candidate.
Installed JS/declaration bytes were compared directly with the built package.

## Exact artifacts and retained raw evidence

The qualified implementation source SHA-256 is
`3990ac9eeb2d304294cc9b1809a1bfd828ed9d1b3d67220148a0f6a18412a1db`.

| Artifact | SHA-256 |
| --- | --- |
| adapter tarball (private pre-release manifest, no version bump) | `c3ef94a5e51a245aa2d8758b82e87976339fad8f883ccd1c99ca564bd3e75d6a` |
| repository package-lock.json | `1c48a7664a621f1ea26f20a49fc77f5c02872f275c807db07c5d15aa4d3b55a8` |
| outside consumer package-lock.json | `cf501d50ba15b84a98f0696a4e3e63f0556631af26b5c7ce30dd7f69f7de4b85` |
| public host 0.3.1 tarball | `8a19a6ae8bcd01fcac2d3b8351fad56bd5347f73c34b48b7c6fcddb4d6c8da0d` |
| public receiver 0.3.1 tarball | `ba59f5a4d168d0f44d8eb3cadac76a8dc345ea79e96bc468e1dfb1253e0578b5` |
| installed public Linux engine binary | `9193fc9c7e7fc0bbdd458c106d3e66114d1c3bfa41c88cb05ff8b90dfa918577` |

Raw logs, original foundation handoff, registry metadata/hash comparisons, lock, extracted quickstart, type
contract, stock harness and own session checkpoint remain in this task worktree's `.receipts/signaling/`.
The packed tar and outside consumer remain in the task-owned `/home/umer/.bkt/bsg/`; no broad cleanup was run.
The foundation commit/history is preserved. No physical phone, personal desktop, account, Mac or model call
was involved. No capture, rendered frame, real input or clipboard journey is claimed. CI owns the full suites;
local qualification was scoped, not a repeated repository-wide suite or native phone build.

## Exact publisher handoff — not a publication receipt

Request the sole coordinated publisher's independent cut of **`@byokit/signaling@0.1.0` only**; no runtime
or internal package dependencies, so no dependent cascade is required. This feature PR leaves the package
private. The publisher's release PR removes `private: true`, compiles the FEAT fragment using the release
prepare flow, and qualifies the exact landed main/release candidate and tarball again. No other pending kit
is part of this request. Publication must use
`--userconfig /home/umer/firstmate/config/npm-platform-kits.npmrc`; the worker did not read it, alter default
npm config, invoke publication or arrange authentication.

Expected public URL after that authorized cut: https://www.npmjs.com/package/@byokit/signaling/v/0.1.0 .
Release notes source: `packages/signaling/changes/fm-byk-bridge-signaling.md` (FEAT only).
Final publication acceptance remains with the publisher: fresh public metadata, matching downloaded tar bytes,
and installed exported adapter at the exact published version. This document proves source/packed transport
qualification; it **does not claim that the adapter is already published**.
