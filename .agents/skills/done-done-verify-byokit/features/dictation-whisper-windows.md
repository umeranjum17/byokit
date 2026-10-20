# Dictation long-take windows

A person dictates for longer than 30 seconds; the built `@byokit/dictation` whisper.rn engine splits the final reading into automatic 30 s windows and stitches them back into one transcript. Nothing spoken is skipped at a pause and no passage is repeated where two windows overlap.

## Sub-features

- `whisper-window-advance`: each automatic window's next window starts an overlap (5 s) before where the decoder actually stopped; a full 30 s reading keeps the fixed 25 s step, an early end (past the overlap) advances to just before the uncovered audio, and an end inside the overlap keeps the fixed step, so a silent or hallucinating decoder still moves by whole windows and a long take always terminates.
- `whisper-window-join`: the overlapping readings are joined once by `mergeOverlap`; an agreed two-word overlap joins through the alignment instead of appending both readings in full.
- `whisper-window-short`: a take of 30 s or less is a single unchanged window.

## How to get to it (user POV)

- The consumer calls `whisperRnEngine({ model, initWhisper, ... }).transcribe(input)` (or `.preview`) with a WAV/PCM input longer than 30 s and `settings.chunkMs` left at 0. The engine's window stepping and join are internal; the app sees one `transcript.text` and one segment per range.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-dictation-windows.mjs"` importing `{ whisperRnEngine }` from `@byokit/dictation`. Build a synthetic 60 s WAV where each second is filled with its index, pass a stub `initWhisper` whose `transcribeData` records the first sample (the window's start second) and returns a chosen reading with a chosen segment `t1`, then call `transcribe(wav, {})` for each shape and assert the window starts and the final text.
- **Run and capture.** `feature=dictation-whisper-windows; entry=@byokit/dictation; drive=(node "$scratch_dir/verify-dictation-windows.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Skip shape.** Readings `[…nine ten (t1 3000)]`, `[eleven twelve thirteen (t1 1300)]`, `[fourteen fifteen sixteen seventeen (t1 3000)]` give window starts `[1, 26, 34]` and a final text that still contains `fourteen fifteen sixteen seventeen`; the unfixed fixed-step build starts the third window at 50 s and drops that speech.
- **Duplicate shape.** Readings `review the quarterly budget` then `the quarterly estimate is approved` then `and the invoice is sent` join to `review the quarterly estimate is approved and the invoice is sent`, not a doubled `quarterly` block.
- **Extreme cases.** A 15 s take returns its single reading; a decoder that always returns nothing still advances by whole windows (`startSecond` strictly increases) and terminates.

## Gotchas

- Import from `@byokit/dictation`; never from `packages/dictation/src`. The stub is `initWhisper`; the real decoder is a host asset, so no model or network is needed to prove the windowing.
- The real phone-mic proof (per-clip WER before/after) uses the regression kit's `tools/windows.mjs` and `tools/runBuilds.mjs` against the built dist and the whisper.cpp bench binary; the scratch consumer above is the self-contained version.
- `mergeOverlap` is shared with the live reread path; the joined text must agree with `transcript.segments` text.
