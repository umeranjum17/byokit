- FEAT: `@byokit/audio/react-native` adds `sileroSession(bytes, onnxruntime-react-native)`, mirroring `./node` on the pinned
  Silero graph (CPU, one thread by default, bytes verified by size and a pure-JS SHA-256 before inference, no `node:*` import).
  `onnxruntime-react-native` 1.24.3 is a new optional peer. Proven with a deterministic fake runtime; handset CPU and
  battery are not measured.
