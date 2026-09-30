# Changelog

## Unreleased

- Add a host-injected whisper.rn adapter with warm serialized inference, cancellation, and validated language, prompt/vocabulary, gain, energy VAD, chunking and decoder settings.
- Add a desktop WER and latency fixture runner with attributed synthetic clean, noisy, fast and technical-name clips and comparison profiles.
- Tune RN finals to fresh full-recording greedy English decoding, preserve quiet audio across pauses, keep vocabulary out of previews, and recommend the host-supplied base.en q5_1 model.
- Import 34 attributed synthetic regression clips, repeatable warm-engine comparisons and a cached path-filtered CI WER gate.

## 0.1.0 (2026-09-30)

- Add `@byokit/dictation` core with injected capture and system recognition, stable partials, final-only corrections, language, timestamps and usage.
- Add child-process transcription using a ChatGPT subscription, API key (billed per use), or an explicitly supplied on-device Whisper binary and model.
- Qualify the public entry and injected system-recognizer port in an Android emulator consumer, through Android SpeechRecognizer and a local fixture RecognitionService.
