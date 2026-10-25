# Changelog

## Unreleased

## 0.3.1 (2026-10-25)

- DOCS: align npm descriptions, keywords and homepages with the BYOKit README.

## 0.3.0 (2026-10-20)

- FEAT: `@byokit/audio/react-native` adds `sileroSession(bytes, onnxruntime-react-native)`, mirroring `./node` on the pinned
  Silero graph (CPU, one thread by default, bytes verified by size and a pure-JS SHA-256 before inference, no `node:*` import).
  `onnxruntime-react-native` 1.24.3 is a new optional peer. Proven with a deterministic fake runtime; handset CPU and
  battery are not measured.

## 0.2.0 (2026-10-12)

- New `@byokit/audio`: shared on-device audio detection with one streaming speech detector (pinned Silero VAD v5.1, MIT, content-addressed) that runs on Node/desktop, React Native and the browser through an app-supplied inference session. No network, no keys, no microphone.
- `@byokit/audio/node` runs the pinned graph on published `onnxruntime-node`, CPU only, one thread by default, from the model bytes or path the app passes. Bytes that are not the pinned graph are rejected before any inference.

## 0.1.0 (2026-10-04)

- Initial public `@byokit/audio`: shared on-device audio detection with one streaming speech
  detector over a pinned, content-verified Silero VAD v5.1 graph (MIT). The kit owns the window
  framing, the recurrent state, the threshold, the hangover and the padding; the app supplies
  the inference session and the model bytes. No network, no keys, no microphone.
- `@byokit/audio/node` runs that pinned graph on published `onnxruntime-node`, CPU only and one
  thread by default. Bytes that are not the pinned graph are rejected before any inference runs.