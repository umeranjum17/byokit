# Fixture provenance

`corpus.json` labels the audio this kit measures its speech detector against. It contains
**no audio**: every clip is a byte-for-byte reuse of a WAV already published in this
repository at `packages/dictation/fixtures/wer/regression/`, referenced by relative path
and pinned by SHA-256 in the corpus. That directory's `NOTICE.md` is the authoritative
provenance: Piper `en_US-ljspeech-high` speech over the public-domain LJ Speech dataset,
plus deterministic pink noise, synthetic babble and seeded room reverb. The package
LICENSE applies; no microphone or personal recording was used.

## Labels

Labels follow that generator's documented contract rather than any detector's output, and
`makeCorpus.mjs` re-derives the file from the committed bytes:

- **Speech** is the whole-utterance envelope from 400 ms to 600 ms before the end, including
  within-utterance pauses. This is a conservative convention, not phonetic frame-level
  annotation.
- **Nuisance** is the lead and tail of every clip. For the silence fixtures that material is
  digital silence (the generator asserts it is, or the build fails); for the hiss, babble and
  reverb fixtures it is the added noise, which the generator lays across the whole clip.
- The generator also verifies each fixture is PCM16 mono 16 kHz before labelling it.

## What this corpus cannot show

It is 13 clips and 81.7 s, of which only 6.0 s is non-silent nuisance. That is enough to
separate the two detectors on real hiss, and thin enough that no real-world rate should be
extrapolated from it. Babble is other speech: a speech detector is expected to fire on it,
and this corpus does not measure speaker identity. Real rooms, real fans and real music are
harder than anything here. The desktop numbers in the kit README are desktop-only.