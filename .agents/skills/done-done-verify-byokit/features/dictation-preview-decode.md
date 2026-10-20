# Dictation live preview decode

A consumer app shows live dictation text while a person speaks. Live previews are throwaway readings: `whisperRnEngine` decodes them greedily over only the most recent `PREVIEW_WINDOW_SECONDS` of the current turn, so a long take does not re-decode the whole recording at the host's final beam; finals and file readings keep the host's `beamSize` and whole-recording window.

## Sub-features

- `preview-greedy`: every preview decode carries no `beamSize` (greedy), whatever the engine's `settings.beamSize` is.
- `preview-window`: a preview reads at most `PREVIEW_WINDOW_SECONDS * 16000` samples, even when the turn is longer.
- `final-full`: a final decode keeps the configured `beamSize` and reads the whole recording (its 30 s/overlap windows).

## How to get to it (user POV)

- A host calls `new Dictation({ engine: whisperRnEngine({ model, initWhisper, settings }) }).listen(...)` and listens for `partial` events. The engine's injected `transcribeData(bytes, decode)` sees every preview and final decode; `decode.beamSize` and `bytes.byteLength` say which settings reached the decoder.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-dictation-preview-decode.mjs"` importing `{ Dictation, whisperRnEngine, PREVIEW_WINDOW_SECONDS }` from `@byokit/dictation` and `{ fakeMic }` from `@byokit/dictation/testing`, with an inline `initWhisper` stub that records `{ bytes: bytes.byteLength, beam: decode.beamSize ?? 'greedy', prompt: decode.prompt }` and returns `'preview guess'` for an empty prompt and `'complete recording'` otherwise. Drive `listen({ prompt, keywords })`, push a loud 1-second frame then a loud 33-second frame, `finish()`, and assert every preview decode is greedy and at most `PREVIEW_WINDOW_SECONDS * 16000 * 2` bytes, every final carries `beamSize 5`, at least one final is larger than the preview window, and the final text is `complete recording`.
- **Run and capture.** `feature=dictation-preview-decode; entry="@byokit/dictation"; drive=(node "$scratch_dir/verify-dictation-preview-decode.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`, last line `preview-decode ok`.

## Gotchas

- Import from `@byokit/dictation` (and `/testing`); never from `packages/dictation/src`.
- This drives the published decode-settings contract with a stub `initWhisper`; real recognition, phone microphone capture and preview lag are proved by `tools/liveReplay.mjs` in the dictation regression evidence over a real whisper.rn-identical bench, not by this consumer.
- No server to clean up — use SKILL.md Cleanup to remove only `"$scratch_dir"` and confirm the captured evidence survives.
