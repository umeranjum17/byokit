#!/usr/bin/env python3
"""Generate synthetic fixtures with an explicitly passed Flite binary; no network."""
import argparse
import array
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--flite', required=True, type=Path)
args = parser.parse_args()
if not args.flite.is_absolute():
    parser.error('--flite must be an absolute path')
root = Path(__file__).resolve().parents[1] / 'fixtures' / 'wer'
manifest = json.loads((root / 'manifest.json').read_text())
for clip in manifest['clips']:
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / 'speech.wav'
        subprocess.run([str(args.flite), '-voice', 'slt', '-setf',
                        f"duration_stretch={clip['generation']['durationStretch']}",
                        '-t', clip['reference'], '-o', str(path)], check=True)
        with wave.open(str(path), 'rb') as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
                raise ValueError('Flite slt must produce PCM16 mono at 16 kHz')
            samples = array.array('h', audio.readframes(audio.getnframes()))
            if sys.byteorder != 'little':
                samples.byteswap()
    # Equal leading/trailing padding makes silence handling observable.
    data = [0] * 3200 + list(samples) + [0] * 8000
    if clip['category'] == 'noisy':
        # Deterministic uniform noise at 12 dB SNR over the complete clip.
        rms = math.sqrt(sum(x * x for x in samples) / len(samples))
        amplitude = rms / (10 ** (12 / 20)) * math.sqrt(3)
        rng = random.Random(731)
        data = [max(-32768, min(32767, round(x + rng.uniform(-amplitude, amplitude)))) for x in data]
    output = array.array('h', data)
    if sys.byteorder != 'little':
        output.byteswap()
    file = root / clip['file']
    with wave.open(str(file), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(output.tobytes())
    clip['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
