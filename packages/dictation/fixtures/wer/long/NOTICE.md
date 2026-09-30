# Long dictation fixtures

These 66.025-, 96.810- and 300-second PCM16 mono 16 kHz recordings concatenate
checksum-verified, committed [synthetic regression clips](../regression/NOTICE.md).
They use the same public-domain LJ Speech training data and Piper voice, authored
references and Apache-2.0 attribution as those sources. No new voice model or
microphone recording is used. The three references contain every joined utterance
in order; no speech is trimmed or stretched. The five-minute clip adds only trailing
silence to reach exactly 300 seconds. Source IDs, padding and output hashes are
recorded in `manifest.json`.

Regenerate from the repository root with Python's standard library:

```sh
python3 packages/dictation/scripts/bench/makeLongFixtures.py
```

The kit's default overlapping final pipeline is measured on every clip with the
same pinned whisper.rn 0.7.2 source, base.en-q5_1 model and portable AVX2 reader
as the short-clip gate. `baseline.json` records the measured hypotheses, edit
counts, per-clip latency and provenance. CI gates these clips separately so their
errors cannot be diluted by the short-clip reference set. Desktop warm inference
does not qualify native phone latency or a physical microphone.
