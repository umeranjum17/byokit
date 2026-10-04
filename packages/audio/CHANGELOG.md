# Changelog

## Unreleased

## 0.1.0 (2026-10-04)

- Initial public `@byokit/audio`: shared on-device audio detection with one streaming speech
  detector over a pinned, content-verified Silero VAD v5.1 graph (MIT). The kit owns the window
  framing, the recurrent state, the threshold, the hangover and the padding; the app supplies
  the inference session and the model bytes. No network, no keys, no microphone.
- `@byokit/audio/node` runs that pinned graph on published `onnxruntime-node`, CPU only and one
  thread by default. Bytes that are not the pinned graph are rejected before any inference runs.