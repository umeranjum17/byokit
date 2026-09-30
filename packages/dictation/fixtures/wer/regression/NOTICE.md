# Regression fixture provenance

These are the exact 34 supplied synthetic WAVs: 12 core fixtures from muxr/pockit commit `6a9419563d574984f90a9cc1a63f6626dad33f1d` (`scripts/dictation/fixtures`), and 22 extended fixtures accompanying the dictation-quality report dated 2026-09-30. The authored fixture text, generator, CPU benchmark reader and historical replay derive from that Apache-2.0 source. The package LICENSE applies; original authors retain their rights. The portable replay identifies its source in its header.

No microphone recordings, personal voice recordings or commercial speech service were used. Speech was synthesized by Piper's `en_US-ljspeech-high` voice, trained from scratch on the public-domain LJ Speech dataset. The [voice model card](https://huggingface.co/rhasspy/piper-voices/raw/main/en/en_US/ljspeech/high/MODEL_CARD) states this provenance; [LJ Speech](https://keithito.com/LJ-Speech-Dataset/) dedicates its recordings and text to the public domain. The voice model itself is not distributed by this package. Piper/ffmpeg/numpy are generator tools, not package runtime dependencies.

`core-source.json` and `extended-source.json` preserve the supplied synthesis instructions, reference text and pronunciation alternatives. `manifest.json` records each clip's source, settings and exact SHA-256. The imported WAVs use PCM16 mono 16 kHz. The generator adds 0.4 s leading / 0.6 s trailing silence, deterministic pink noise or synthetic babble, pitch/tempo transformations, seeded synthetic room reverb, long sentence pauses and quiet −42/−45 dBFS levels where specified. Names sometimes have phonetic synthesis text; scoring always uses the intended written reference.

To regenerate, obtain the [voice ONNX](https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/high/en_US-ljspeech-high.onnx) and adjacent `.onnx.json`, install `piper-tts`, `numpy`, and `ffmpeg`, then run from the repository root:

```sh
python3 packages/dictation/scripts/bench/makeFixtures.py /absolute/path/to/en_US-ljspeech-high.onnx packages/dictation/fixtures/wer/regression/core-source.json
python3 packages/dictation/scripts/bench/makeFixtures.py /absolute/path/to/en_US-ljspeech-high.onnx packages/dictation/fixtures/wer/regression/extended-source.json
```

Generator versions were not supplied with the source report. Regeneration may change bytes: review the WAVs/references and intentionally update hashes and measured baselines together. CI consumes the committed bytes and never generates audio. `baseline.json` records matching engine/model/build provenance, the native comparison, portable CI baseline, and the supplied report's numbers with explicit reproduction differences.
