# Changelog

## Unreleased

## 0.2.0 (2026-09-30)

- Bundled Linux X11 video recorder, selected when `CaptureOptions.bin` is omitted; explicit bins retain protocol-v1 pass-through.
  Explicit start only, local private takes, stop/abort cleanup, MP4 title metadata and timed subtitle rendering.
  No audio, input-event capture or planner; Wayland, macOS, Windows and mobile are unsupported by this backend.
  Fake media-tool tests and an isolated real-recorder Linux CI smoke replace reliance on owner-machine proof alone.

- Rename: `@byokit/capture` is now `@byokit/record` (packages/record); recorder protocol v1 is unchanged.
  No longer `private`.

## 0.1.0

- Scaffold (docs/capability-kits.md BK-0): frozen public types, the `Capture` client, supervision and protocol
  seams, `./testing` and words. Bodies throw `not built` until BK-C1 (recorder protocol v1 schema, parsers, fake
  recorder, contract) and BK-C2 (the client and supervision) land.
- BK-C1: recorder protocol v1 schema, wire parsers with the 6.7 error mapping, the scripted fake recorder and the
  contract suite. The contract runs against the fake recorder in BK-C2.
- BK-C2: the `Capture` client (hello gate, `record()` as an async iterator with stop, abort and the wall-clock
  guard, `stop()`, `make()`) over supervision: an absolute bin only, an env built from nothing, argv arrays with NUL
  rejected, timeouts, output caps, process-group SIGTERM then SIGKILL, and the planner key on fd 3 only.
  `eventWords` and `errorWords` map to the 5.6 sentences. The contract runs against the fake recorder; its record
  cases now skip `consent-pending` on a `screen` source and check `out` against the take.
