# Dictation file VAD windows

A person dictates a long take with short pauses on an app that turns on file VAD (`settings.vad.enabled`, energy or a `vad` session factory). Every whisper.cpp decode pays one full encode however short its audio, so the built `@byokit/dictation` whisper.rn engine never reads a take in more pieces than it would with the gate off, and the gate changes no word of it.

## Sub-features

- `file-vad-same-windows`: a take longer than one decode window reads exactly the ungated windows, byte for byte, and skips each one that overlaps no speech range. It decodes no more windows than the same take ungated, and its text is the ungated text.
- `file-vad-silence-skipped`: a window with no speech never reaches the decoder. A take with no speech decodes nothing.
- `file-vad-short-take`: a take within one window is one read from first speech to last, however many pauses it holds. Lead and tail silence are dropped.
- `file-vad-explicit-chunks`: an explicit `chunkMs` keeps its fixed chunks, with silent chunks skipped.

## How to get to it (user POV)

- The consumer builds `whisperRnEngine({ model, initWhisper, settings: { vad: { enabled: true } } })`, optionally with `vad: async () => session`, and calls `new Dictation({ engine }).transcribe(wav)`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-dictation-file-vad.mjs"` importing `{ Dictation, whisperRnEngine }` from `@byokit/dictation`. Pass a stub `initWhisper` whose `transcribeData` records each window's samples and returns one word per distinct nonzero level in the window, with `t1` at the window's end. Build a WAV in the test whose 1 s bursts each have their own level. Then run these takes gate off and gate on, and print decode counts and text:
  - 180 s with a burst every 3 s from 0 to 70 s and from 145 to 175 s: same text; fewer decodes gated; every gated window equals an ungated window; none is pure silence.
  - 20 s cut from the same take: one decode, shorter than the 20 s take's audio span.
  - 120 s of zeros: empty text, no decode.
- **Run and capture.** `feature=dictation-file-vad-windows; entry=@byokit/dictation; drive=(node "$scratch_dir/verify-dictation-file-vad.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Extreme case.** The 180 s take on the unfixed build (`@byokit/dictation` 0.6.1) decodes one range per burst: more decodes than ungated.

## Native cost

The stub proves the windows, not the cost. Measured with whisper.rn 0.7.2's own vendored whisper.cpp, `base.en-q5_1`, 2 decode threads pinned to 2 host cores, through the built engine, on a 10-minute take of 12 s bursts with 3 s pauses:

- Gate off: 24 decodes, 51–58 s.
- Before, energy: 89 decodes, 92–106 s. Before, Silero through a `vad` factory: 83 decodes, 89–109 s. That is 1.6–2.1 times gate off in the same run.
- After, energy: 24 decodes, 51–58 s. After, Silero: 24 decodes, 51–58 s. Text byte-identical to gate off.
- The other phases do not own the cost: the whole-recording Silero pass is about 1.2–1.9 s of those runs and session creation about 50–65 ms. The `speech` option's windows cost about 1.5 ms per second of audio.

A take of 5 s bursts every 40 s gains less than it did: about 45–50 s after, against 18–22 s read range by range and 44 s ungated, because nearly every window holds a burst. That is the price of identical text; it is never slower than the gate off beyond the VAD pass.

## Gotchas

- Import from the published entries; never from `packages/dictation/src`. The journey test imports the built package, so rebuild before you run it.
- Native text can change when a window moves by even 200 ms, so a fix that shifts windows shows up only on the real decoder, not the stub.
- Skipping a silent window can drop a tag such as `[BLANK_AUDIO]` that gate off made up there; a tag in a window that also holds speech stays. That difference from gate-off text is the gate working.
