// Derives packages/audio/fixtures/vad/corpus.json from the committed dictation
// regression WAVs. Nothing is downloaded or synthesized: every clip is a byte-for-byte
// reuse of an already published fixture, and every label comes from the generator
// contract recorded in that directory's NOTICE.md (0.4 s leading / 0.6 s trailing
// silence, noise added across the whole clip). Run: node packages/audio/scripts/makeCorpus.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../../dictation/fixtures/wer/regression');
const out = join(here, '../fixtures/vad/corpus.json');
const LEAD_MS = 400, TAIL_MS = 600;

/** kind: clean fixtures keep digital silence around the utterance; noise fixtures
 * carry that added noise across the whole clip, so their lead and tail are the
 * label-negative nuisance material this corpus can honestly measure. */
const CLIPS = [
  ['clean-short', 'silence'], ['clean', 'silence'], ['quiet', 'silence'], ['fast', 'silence'],
  ['technical', 'silence'], ['names', 'silence'], ['pauses', 'silence'],
  ['noisy-hiss', 'hiss'], ['noisy-babble', 'babble'], ['x-hiss-5', 'hiss'],
  ['x-hiss-15', 'hiss'], ['x-babble-12', 'babble'], ['x-reverb', 'reverb'],
];

function decode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = at => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV');
  let rate = 0, channels = 0, bits = 0, data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true), end = at + 8 + size;
    if (tag(at) === 'fmt ') { channels = view.getUint16(at + 10, true); rate = view.getUint32(at + 12, true); bits = view.getUint16(at + 22, true); }
    if (tag(at) === 'data') data = bytes.subarray(at + 8, end);
    at = end + (size % 2);
  }
  if (rate !== 16000 || channels !== 1 || bits !== 16 || !data || data.length % 2) throw new Error('fixture is not PCM16 mono 16 kHz');
  const pcm = new Int16Array(data.length / 2), samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < pcm.length; i++) pcm[i] = samples.getInt16(i * 2, true);
  return pcm;
}
const rms = (pcm, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (pcm[i] / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};
const db = value => Math.round(20 * Math.log10(Math.max(value, 1e-9)) * 10) / 10;

const clips = CLIPS.map(([id, noise]) => {
  const bytes = readFileSync(join(source, `${id}.wav`));
  const pcm = decode(bytes);
  const durationMs = Math.round(pcm.length / 16);
  const speech = [[LEAD_MS, durationMs - TAIL_MS]];
  const nuisance = [[0, LEAD_MS], [durationMs - TAIL_MS, durationMs]];
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i] / 32768));
  if (noise === 'silence') for (const [from, to] of nuisance) {
    if (rms(pcm, Math.round(from * 16), Math.round(to * 16)) > 0.0025) throw new Error(`${id} lead/tail is not the digital silence its label claims`);
  }
  return {
    id, file: `../../../dictation/fixtures/wer/regression/${id}.wav`, noise, durationMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    speechMs: speech, nuisanceMs: nuisance,
    speechDb: db(rms(pcm, speech[0][0] * 16, speech[0][1] * 16)),
    nuisanceDb: db(Math.max(rms(pcm, 0, LEAD_MS * 16), rms(pcm, (durationMs - TAIL_MS) * 16, pcm.length))),
    peak,
  };
});

const span = ranges => ranges.reduce((sum, [from, to]) => sum + to - from, 0);
const total = key => clips.reduce((sum, c) => sum + span(c[key]), 0);
writeFileSync(out, JSON.stringify({
  notice: 'Labels derived from the committed dictation regression fixtures and that directory\'s NOTICE.md: the generator places speech at 400 ms and stops it 600 ms before the end. The lead and tail of every clip are label-negative; for the noise fixtures that material is the added hiss, babble or reverb, not silence. See NOTICE.md next to this file.',
  labelConvention: 'Whole-utterance envelope, including within-utterance pauses. Not phonetic frame-level annotation.',
  scoring: { binMs: 20, detectorFrameMs: 32, threshold: 0.5, note: 'Identical to the evaluation that chose this detector: 20 ms bins scored by the containing frame, onset latency from the END of the first overlapping positive frame.' },
  totals: { speechMs: total('speechMs'), nuisanceMs: total('nuisanceMs'), nuisanceAudioMs: clips.filter(c => c.noise !== 'silence').reduce((s, c) => s + span(c.nuisanceMs), 0) },
  clips,
}, null, 2) + '\n');
console.log('wrote', out, 'clips', clips.length, 'speech s', (total('speechMs') / 1000).toFixed(2), 'nuisance s', (total('nuisanceMs') / 1000).toFixed(2));