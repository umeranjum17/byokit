# @byokit/signaling: foundation and remaining checklist

Delete this file in the PR that finishes the kit. It is not in `files`, so it is never packed.

## Decision: package home and scope

- **Package:** new `@byokit/signaling` (`packages/signaling`), version 0.1.0, `private: true` until the release cut.
  The npm name returned 404 on 2026-10-02.
- **Scope:** a reusable signaling transport, and nothing more. The kit has one request path and one notification
  stream over a bridge WebSocket, plus a helper that opens a fresh socket on every authorization. It adds no
  desktop capability, UI or session logic.
- **Why not an existing package:**
  - `@byokit/reach` autolinks an Expo native module and `react-native-zeroconf` into every app that installs it, and
    a release would cascade to openclaw and herdr.
  - `@byokit/link` is the Noise-encrypted pairing link. Adding a plain token WebSocket there would blur its security
    story, and a release would cascade to relay.
  - A capability-named one-word kit with no dependencies installs anywhere (kit-conventions §1.1).
- **Owner sign-off:** kit-conventions §1.2 asks a new kit to confirm its name with the owner before its first
  publish. Root should relay that at the release cut.

## Wire, from the published sources (read-only, `npm pack` of @desklink/host 0.3.1 and @desklink/react-native 0.3.1)

- **Authorization:** the bridge's `verifyClient` checks the URL's `?token=` at the WebSocket upgrade. A wrong token
  never opens the socket. A WebSocket in a browser, React Native or Node cannot tell that refusal from an
  unreachable host, so both reject with `transport`. This is documented, not hidden.
- **Requests and responses:**
  - A request is `{id, method, params?}`.
  - A success is `{id, result}`.
  - A refusal is `{id, error: {code, message}}`. The bridge's own codes include `source`, `operation` and
    `malformed`; engine codes are passed through.
  - A frame with no id, such as `{error: {code: 'malformed'}}`, is ignored.
- **Events:** an event is `{event, params}`. The bridge broadcasts every engine event to every socket except
  `session.restoreToken` and `session.frame.changed`.
- **Event mapping:** these events are mapped to `SessionEvent`:
  - `description`
  - `candidate`
  - `state`
  - `cursor`
  - `restoreToken`, kept for parity
  - `revoked`, including its `code`
  
  Other events (`capture.stopped`, `keyframeRequest`, `input`) are dropped.
- **Handshake:** the host's `EngineClient` sends `hello` itself. The client never has to.
- **Disconnects:** when its socket closes, the bridge releases that socket's session. So an unexpected close after
  the socket opened emits a synthetic `{kind: 'revoked', code: 'transport'}`. The hook's reopen policy then calls
  `authorize` again, which opens a fresh socket.
- **Type compatibility:** `Signaling` and `SessionEvent` are structural copies of `@desklink/react-native` 0.3.1
  `src/protocol.ts`. There is deliberately no dependency on it, because it peers on expo, react-native and webrtc.
- **Hook error codes:** the hook's `classifyOpenFailure` maps `transport` to retryable. `closed` falls to
  `platform`, which only happens after the app itself called `close()`.

## Files in this foundation

- `packages/signaling/src/index.ts`, which exports:
  - `bridgeSignaling`
  - `authorizeBridge`
  - `toSessionEvent`
  - `SignalingError` and `SignalingErrorCode`
  - the types `Signaling`, `BridgeSignaling`, `SessionEvent`, `RtcDescription`, `RtcCandidate`, `CursorSample`,
    `WebSocketLike` and `BridgeSignalingOptions`
- `packages/signaling/test/bridge.test.ts`: mock-bridge loopback tests, not the stock host.
- `packages/signaling/test/portable.test.ts`: checks there are no `node:` imports in the bundled entry.
- `packages/signaling/{package.json,tsconfig.json,LICENSE,CHANGELOG.md}` and
  `changes/fm-byk-bridge-signaling.md` (the FEAT fragment).
- Root `package.json` build list and `scripts/release.ts` canonical order now include `signaling`.
  `package-lock.json` is not updated yet.

## Remaining acceptance (for the builder)

1. Run `npm install` under the heavy lock to add `packages/signaling` to `package-lock.json`, then run `npm ci`
   cleanly.
2. Run `tsc -b packages/signaling` (done green in this foundation, see the receipt below), then the root
   `npm run check` on a fresh `npm run build`. The root check showed only stale-dist errors from other packages in
   this worktree.
3. Run `sh scripts/test.sh 'packages/signaling/test/*.test.ts'` and fix anything that fails. The tests were written
   but are not yet green.
4. Write `README.md` in the house style (copy seal's header and badges). It needs:
   - a 30-line React Native quickstart that uses
     `authorizeBridge(url, { permissions: CONTROL_PERMISSIONS })` as `useDesktopSession({ authorize })`
   - the error codes
   - the token-refusal-looks-like-transport limit
   - the Node 22+ / browser / React Native platforms
5. Add the package to the root `README.md` package tables, as with `@byokit/seal`.
6. Add a `scripts/pack-smoke.ts` entry: import `bridgeSignaling`, and connect it to a loopback `ws` echo inside the
   scratch app.
7. Do the outside-repo proof. Use an `npm pack`ed tarball plus published `@desklink/react-native@0.3.1`, in a scratch
   project with an isolated HOME and TMPDIR under `/home/umer/.bkt/`, and run `tsc` on an App.tsx of about 30 lines.
   Signaling must be assignable to the hook's `authorize` result type. Label this as a type and bundle proof only.
8. If feasible, run a loopback against stock `npx @desklink/host@0.3.1 bridge` on a task-owned Xvfb, with
   `listen 127.0.0.1:0`. It should cover:
   - `hello` and `capabilities` round trip
   - the refusal for `session.open` with a `source` parameter (`code: 'source'`)
   - a wrong token giving `transport`
   - fresh-socket reauthorization
   
   Label this as stock-host proof, not a phone proof.
9. Release cut, handed to Root, not published by the builder:
   - a release PR removes `private: true` and runs `npm run release -- prepare signaling=0.1.0`
   - publication is `@byokit/signaling@0.1.0`, with no `@byokit` dependencies and no runtime dependencies
   - the first publish is local, then `npm trust github`, per CONTRIBUTING
10. Open a direct PR from `fm/byk-bridge-signaling` that is not a draft.

## Receipts (foundation)

- `npx tsc -b packages/signaling` exited 0 on 2026-10-02 (commit below). The same chained run's root `tsc -p tsconfig.json`
  then failed only in `examples/openclaw-kit/*` and `packages/openclaw/src/link.ts`, which are stale sibling `dist/`
  types in this worktree, not this kit. So the tests in the chain did not run.
- A second scoped check/test run was stopped while it waited on the shared heavy lock. The signaling tests have
  never been executed: item 3 is open.
