# Dictation speech gate windows

A person finishes a long take on a phone that ships whisper.rn's Silero VAD (`speech: { model, initWhisperVad }`). The built `@byokit/dictation` whisper.rn engine checks the take for speech in 30 s windows, each just before the first decode window that needs it. It skips decode windows with no speech and reports progress per window, so a long take starts decoding after one check and 120 s of room noise returns empty text quickly instead of hanging on one whole-take check.

## Sub-features

- `speech-gate-windows`: each 30 s gate window is checked once (`detectSpeechData` gets at most 30 s of PCM16). A decode window that overlaps no window with speech is never decoded. A take with no speech in any window returns empty text with no decode.
- `speech-gate-first-decode`: a take with speech in its first window starts its first decode after exactly one check.
- `speech-gate-abort`: `options.signal` aborted during a check stops the reading with `DictateError` `cancelled` before the next window is checked.
- `speech-gate-progress`: `onProgress` receives `{ phase: 'speech', doneMs, totalMs }` after each check and `{ phase: 'decode', doneMs, totalMs }` after each decode, in order. Previews report nothing.
- `speech-gate-threads`: `initWhisperVad` is called once per engine with `nThreads: 1`. whisper.rn's Android default of 4 VAD threads made a 2-core device check 7–8 s per second of audio; 1 thread checks about 10 ms per second.

## How to get to it (user POV)

- The consumer builds `whisperRnEngine({ model, initWhisper, speech: { model, initWhisperVad } })` and calls `new Dictation({ engine }).transcribe(wav, { onProgress })`, or `listen({ onProgress })` then `finish()`. The host shows the progress, for example "Checking for speech 30/120 s".

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-dictation-speech-gate.mjs"` importing `{ Dictation, whisperRnEngine, DictateError }` from `@byokit/dictation`. Pass a stub `initWhisper` whose `transcribeData` records the decoded byte length and returns a fixed reading. Pass a stub `initWhisperVad` that records its options and returns a `detectSpeechData` reporting one segment when any sample is nonzero. Then run these takes and print every call and progress event with a timestamp:
  - 120 s of zeros: text `''`; four checks of 30 s each; no decode; progress `speech` 30/60/90/120 s of 120 s.
  - 75 s with samples filled from 60 s on: three checks (30, 30, 15 s); one decode of the 25 s window [50 s, 75 s); progress `speech` 30, 60, 75 then `decode` 75.
  - 65 s filled from 0 s: the first decode starts after exactly one check.
  - 120 s of zeros with an `AbortController` aborted inside the first check: rejects with `DictateError` code `cancelled` after one check.
  - Assert that `initWhisperVad` received `nThreads: 1`.
- **Run and capture.** `feature=dictation-speech-gate; entry=@byokit/dictation; drive=(node "$scratch_dir/verify-dictation-speech-gate.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Extreme case.** The 120 s silence take: on the unfixed build (`@byokit/dictation` 0.5.1) the stub sees one 120 s check and no progress. On the fixed build it sees four bounded checks.

## Native cost on a device

The stubs prove the windowing, not the native cost. The cost behind `nThreads: 1` was measured on a private 2-core x86_64 API 35 emulator. The measurement ran whisper.rn 0.7.2's own vendored whisper.cpp, built with whisper.rn's Android x86_64 flags, and drove the built kit's `whisperRnEngine` through it, before (npm 0.5.1) and after. The figures:

- 4 threads: about 8 s per second of audio. 1 thread: about 10 ms per second. Init is about 1 ms.
- After the fix, 120 s of near-silence returns empty text in about 1 s.

The harness and logs are in the PR's private evidence page. To re-measure, rebuild that harness from the page rather than trusting the figures above on a different device class.

## Gotchas

- Import from `@byokit/dictation`; never from `packages/dictation/src`. No model, device or network is needed for the windowing proof.
- The gate grid is fixed at 30 s regardless of an explicit `settings.chunkMs`. Short explicit chunks share their 30 s window's decision, because Silero drops speech shorter than 250 ms and so cannot judge a 100 ms chunk on its own.
- Decode threads are separate: see [dictation-decode-threads](./dictation-decode-threads.md).
