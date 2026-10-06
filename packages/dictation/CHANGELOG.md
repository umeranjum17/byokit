# Changelog

## Unreleased

## 0.4.0 (2026-10-06)

- `whisperRnEngine` takes an optional `speech: { model, initWhisperVad }`. Every final and file reading first runs whisper.rn's Silero VAD (`detectSpeechData`) and skips the decode when it finds no speech, so a recording of room noise returns empty text instead of made-up sentences. When speech is found the whole recording is decoded as before; previews are not gated. `WHISPER_VAD_MODEL` pins the ~0.9 MB `ggml-silero-v6.2.0` graph (URL, size, SHA-256) for `installModel`; the kit still downloads nothing.
- `whisperRnEngine` takes an optional `vad` session factory. When the app supplies one, the live turn gate takes its per-frame speech decisions from the shared pinned neural detector from `@byokit/audio`, so a loud keyboard or fan no longer opens a turn; offline segmentation runs that detector instead of the energy gate only when `settings.vad.enabled` is true, and keeps the whole file otherwise. Without the factory every path behaves exactly as before, including the unchanged 0.0025 energy threshold.
- The live turn gate disposes the detector on both finish and cancel. One session per stream, because a session carries recurrent state.

## 0.3.0 (2026-09-30)



- FIX: Accept live dictation up to a configurable 300-second default limit and join overlapping Whisper final windows without cutting words at token timestamps.
- FIX: Drain audio captured during an in-flight preview before final inference so stopping preserves the complete recording.

## 0.2.0 (2026-09-30)



- Add a host-injected whisper.rn adapter with warm serialized inference, cancellation, and validated language, prompt/vocabulary, gain, energy VAD, chunking and decoder settings.
- Add a desktop WER and latency fixture runner with attributed synthetic clean, noisy, fast and technical-name clips and comparison profiles.
- Tune RN finals to fresh full-recording greedy English decoding, preserve quiet audio across pauses, keep vocabulary out of previews, and recommend the host-supplied base.en q5_1 model.
- Import 34 attributed synthetic regression clips, repeatable warm-engine comparisons and a cached path-filtered CI WER gate with one-repeat/two-thread measurements, early cache saving and per-clip progress.

## 0.1.0 (2026-09-30)

- Add `@byokit/dictation` core with injected capture and system recognition, stable partials, final-only corrections, language, timestamps and usage.
- Add child-process transcription using a ChatGPT subscription, API key (billed per use), or an explicitly supplied on-device Whisper binary and model.
- Qualify the public entry and injected system-recognizer port in an Android emulator consumer, through Android SpeechRecognizer and a local fixture RecognitionService.
