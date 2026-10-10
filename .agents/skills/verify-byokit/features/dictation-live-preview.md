# Dictation live preview

A consumer app shows a live dictation preview while a person speaks. A reading that agrees with the previous reading is shown; shown words are never retracted, so the preview is stable — except a shown silence sentinel (`[BLANK_AUDIO]`), which a reread engine may return for a silent window and which must drop the moment real words arrive instead of sticking in front of the speech.

## Sub-features

- `preview-silent-then-speech`: a take that starts silent shows `[BLANK_AUDIO]`, and the first reading that carries real words drops it; the live preview then grows with the agreed words.
- `preview-silence-only`: a silence-only take keeps showing the sentinel (or empty), matching the current final behaviour.
- `preview-sentinel-between-speech`: a sentinel reading between two spoken parts never sticks and never retracts the real shown words.
- `preview-stable-real-words`: real shown words keep today's policy — only the prefix two readings agree on is exposed, and nothing already shown is taken back.

## How to get to it (user POV)

- A reread engine (`whisperRnEngine`, or the app-supplied recognizer) emits partial readings while `Dictation.listen()` captures PCM; the app listens for `partial` events and shows `segment.text`. `settleWords(shown, previous, next)` is the published function that decides that text, so a consumer can also drive the policy directly.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-dictation-live-preview.mjs"` importing `{ Dictation, settleWords }` from `@byokit/dictation` and `{ fakeEngine, fakeMic }` from `@byokit/dictation/testing`. Drive the two behaviours: (1) call `settleWords` for the silent-then-speech, silence-only and sentinel-between-speech cases and print each result; (2) drive the real `listen()` path with a fake engine whose readings are `['[BLANK_AUDIO]', '[BLANK_AUDIO]', 'Okay so', 'Okay so the dictation']`, pushing a loud 1-second frame per expected read, and print the `partial` texts and the final.
- **Run and capture.** `feature=dictation-live-preview; entry=@byokit/dictation; drive=(node "$scratch_dir/verify-dictation-live-preview.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Silent-then-speech.** `settleWords('[BLANK_AUDIO]', '[BLANK_AUDIO]', 'Okay so the dictation')` is `''`; on the live path the sentinel is not the last partial and `Okay so` appears after it. Before the fix the sentinel was the last partial and no words followed.
- **Silence only / between speech.** `settleWords('[BLANK_AUDIO]', '[BLANK_AUDIO]', '[BLANK_AUDIO]')` keeps `[BLANK_AUDIO]`; `settleWords('Okay so the dictation', 'Okay so the dictation quality', '[BLANK_AUDIO]')` keeps `Okay so the dictation`.

## Gotchas

- Import from `@byokit/dictation` (and `/testing`); never from `packages/dictation/src`.
- The real phone/desktop engine path is driven by `tools/liveReplay.mjs` in the dictation regression evidence (a real whisper.rn-identical bench over a phone clip), not by this scratch consumer; this consumer proves the published policy and the live `partial` events with the repo's own stand-ins.
- No server to clean up — use SKILL.md Cleanup to remove only `"$scratch_dir"` and confirm the captured evidence survives.
