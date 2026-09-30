#!/usr/bin/env python3
"""Join checksum-verified, attributed synthetic clips; no new voice/model needed.

Run from the repository root: python3 packages/dictation/scripts/bench/makeLongFixtures.py
The ordered source IDs and padding are recorded in the generated manifest.
"""
import hashlib
import json
import wave
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[2] / 'fixtures' / 'wer'
    source = root / 'regression'
    manifest = json.loads((source / 'manifest.json').read_text())
    clips = {clip['id']: clip for clip in manifest['clips']}
    short = ['long', 'x-long-1', 'x-long-2']
    medium = short + ['long-names', 'names', 'technical']
    # Different utterances across every join, including quiet speech, names,
    # pauses and repeated words. Reuse only the committed synthetic sources.
    five_minutes = medium + [
        'clean', 'pauses', 'x-phone-long', 'x-long-2',
        'x-phone-clean', 'x-pauses-1', 'x-names-2', 'long', 'x-tech-3',
        'x-phone-pauses', 'long-names', 'x-long-1', 'x-clean-2', 'names',
        'x-pauses-2', 'technical', 'x-phone-clean',
    ]
    output = root / 'long'
    output.mkdir(exist_ok=True)
    result = {'clips': [], 'profiles': [p for p in manifest['profiles'] if p['id'] in ['default', 'application-vocabulary']]}
    for name, ids, target_seconds in [('joined-66', short, None), ('joined-97', medium, None), ('joined-300', five_minutes, 300)]:
        data = bytearray()
        for ident in ids:
            clip = clips[ident]
            path = source / clip['file']
            if hashlib.sha256(path.read_bytes()).hexdigest() != clip['sha256']:
                raise ValueError(f'Source checksum mismatch: {ident}')
            with wave.open(str(path)) as wav:
                if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                    raise ValueError(f'Invalid source PCM: {ident}')
                data.extend(wav.readframes(wav.getnframes()))
        padding = 0 if target_seconds is None else target_seconds * 16000 - len(data) // 2
        if padding < 0:
            raise ValueError('Sources exceed target duration; never trim speech')
        data.extend(bytes(padding * 2))
        path = output / f'{name}.wav'
        with wave.open(str(path), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(data)
        result['clips'].append({
            'id': name, 'category': 'long', 'file': path.name,
            'reference': ' '.join(clips[ident]['reference'] for ident in ids),
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'source': 'Concatenated synthetic Piper en_US-ljspeech-high regression clips; see ../regression/NOTICE.md',
            'generation': {'sourceManifest': '../regression/manifest.json', 'sourceIds': ids, 'trailingSilenceSamples': padding},
        })
        print(f'{name}: {len(data) / 32000:.3f} s')
    (output / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
