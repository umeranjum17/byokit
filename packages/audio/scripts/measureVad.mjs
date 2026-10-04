// Measured proof for the adopted detector, through this package's BUILT exports.
// Real pinned Silero v5.1 bytes on published onnxruntime-node, CPU only, against the
// unchanged energy gate and the real dictation consumer. No synthetic audio, no network,
// no GPU, no microphone.
// Run: node packages/audio/scripts/measureVad.mjs --model <path-to-silero_vad.onnx>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVad, SILERO_VAD_5_1, VAD_RATE, VAD_THRESHOLD } from '../dist/index.js';
import { sileroSession } from '../dist/node.js';
import { transcribeWhisper, whisperSettings } from '../../dictation/dist/whisper.js';
import corpus from '../fixtures/vad/corpus.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const runtime = require('onnxruntime-node');
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const flag = process.argv.indexOf('--model');
if (flag < 0) { console.error('pass --model <path to the pinned silero_vad.onnx>'); process.exit(2); }
const modelBytes = readFileSync(process.argv[flag + 1]);
const BIN_S = corpus.scoring.binMs / 1000, REPEATS = 5;

function decode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = at => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  let data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true), end = at + 8 + size;
    if (tag(at) === 'data') data = bytes.subarray(at + 8, end);
    at = end + (size % 2);
  }
  const pcm = new Int16Array(data.length / 2), samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < pcm.length; i++) pcm[i] = samples.getInt16(i * 2, true);
  return pcm;
}
const clipPath = clip => resolve(root, 'packages/audio/fixtures/vad', clip.file);
const clipOf = clip => decode(readFileSync(clipPath(clip)));
const inside = (t, ranges) => ranges.some(([from, to]) => from <= t && t < to);
const ms = ranges => ranges.map(([from, to]) => [from / 1000, to / 1000]);

// The unchanged gate in packages/dictation/src/whisper.ts, transcribed: normalized
// PCM16 RMS over 320 samples, strictly above the threshold that kit resolves.
const energyThreshold = whisperSettings({ vad: { enabled: true } }).vad.threshold;
function energyFrames(pcm) {
  const frames = [];
  for (let at = 0; at < pcm.length; at += 320) {
    const end = Math.min(pcm.length, at + 320);
    let sum = 0;
    for (let i = at; i < end; i++) sum += (pcm[i] / 32768) ** 2;
    frames.push([at / VAD_RATE, end / VAD_RATE, Math.sqrt(sum / (end - at)) > energyThreshold]);
  }
  return frames;
}
/** Score one stream with an existing session. `reset()` clears the recurrent state
 * without disposing the session, which is how a host reuses one warm session. */
async function neuralFrames(pcm, session) {
  const vad = createVad({ session });
  try {
    const frames = [...await vad.push(pcm), ...await vad.flush()];
    return frames.map(f => [f.startMs / 1000, f.endMs / 1000, f.speech]);
  } finally { vad.reset(); }
}

/** The evaluation's frozen scoring recipe: 20 ms bins, the containing frame decides,
 * a false activation is a rising edge inside label-negative material, and onset latency
 * is measured from the END of the first overlapping positive frame. */
function score(clip, frames) {
  const truth = ms(clip.speechMs), negative = ms(clip.nuisanceMs);
  const bins = [];
  for (let t = BIN_S / 2; t < clip.durationMs / 1000; t += BIN_S) {
    let i = 0;
    while (i + 1 < frames.length && t >= frames[i][1]) i++;
    bins.push({ t, positive: inside(t, truth), speech: frames[i][2] });
  }
  let previous = false, activations = 0, falseActivations = 0;
  for (const bin of bins) {
    if (bin.speech && !previous) { activations++; if (!bin.positive) falseActivations++; }
    previous = bin.speech;
  }
  const latencies = [];
  for (const [from, to] of truth) {
    const hit = frames.find(([start, end, speech]) => speech && end > from && start < to);
    if (hit) latencies.push(Math.max(0, hit[1] - from) * 1000);
  }
  const positiveBins = bins.filter(b => b.positive), negativeBins = bins.filter(b => !b.positive);
  const tp = positiveBins.filter(b => b.speech).length, fp = negativeBins.filter(b => b.speech).length;
  return { tp, fn: positiveBins.length - tp, fp, tn: negativeBins.length - fp, activations, falseActivations,
    negativeMinutes: negativeBins.length * BIN_S / 60, latencies,
    missedUtterances: truth.length - latencies.length,
    negativeAudioMinutes: negative.reduce((sum, [from, to]) => sum + (to - from), 0) / 60 };
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] * 100) / 100;
};
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

const timed = { energy: { wall: 0, cpu: 0 }, neural: { wall: 0, cpu: 0 } };
const rows = [];
let firstFrameMs = null, sessionInitMs = 0;
// One warm session for the whole run, exactly as the evaluation measured it: session
// creation is reported on its own and kept out of the per-audio-second cost.
const session = await sileroSession(modelBytes, runtime);
sessionInitMs = session.initMs;
try {
  {
    const vad = createVad({ session });
    const before = performance.now();
    await vad.push(clipOf(corpus.clips[0]).subarray(0, 512)); // one window, cold kernel selection alone
    firstFrameMs = performance.now() - before;
    vad.reset();
  }
  for (const clip of corpus.clips) {
    const pcm = clipOf(clip);
    rows.push({ id: clip.id, noise: clip.noise, speechDb: clip.speechDb, nuisanceDb: clip.nuisanceDb,
      energy: score(clip, energyFrames(pcm)), neural: score(clip, await neuralFrames(pcm, session)) });
  }
  // Warm repeats: audio already decoded, no disk I/O inside the timed section.
  const decoded = corpus.clips.map(clip => clipOf(clip));
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    for (const pcm of decoded) {
      for (const [name, run] of [['energy', async () => energyFrames(pcm)], ['neural', async () => neuralFrames(pcm, session)]]) {
        const wall = performance.now(), cpu = process.cpuUsage();
        await run();
        const used = process.cpuUsage(cpu);
        timed[name].wall += performance.now() - wall;
        timed[name].cpu += (used.user + used.system) / 1e6;
      }
    }
  }
} finally { await session.release(); }
const audioSeconds = corpus.clips.reduce((sum, clip) => sum + clip.durationMs, 0) / 1000;
const field = (key, name) => rows.reduce((sum, row) => sum + row[key][name], 0);
const summary = key => {
  const tp = field(key, 'tp'), fn = field(key, 'fn'), negativeMinutes = field(key, 'negativeMinutes');
  const negativeAudioMinutes = rows.filter(row => row.noise !== 'silence').reduce((sum, row) => sum + row[key].negativeAudioMinutes, 0);
  const latencies = rows.flatMap(row => row[key].latencies);
  return {
    tp, fn, fp: field(key, 'fp'), tn: field(key, 'tn'),
    missedSpeechPct: round(fn / (tp + fn) * 100, 2),
    falseActivations: field(key, 'falseActivations'),
    falseActivationsPerNegativeMinute: round(field(key, 'falseActivations') / negativeMinutes, 2),
    nonSilentNegativeMinutes: round(negativeAudioMinutes, 4),
    fpBinShareOfNonSilentNuisance: round(rows.filter(row => row.noise !== 'silence')
      .reduce((sum, row) => sum + row[key].fp, 0) / Math.max(1, rows.filter(row => row.noise !== 'silence').reduce((sum, row) => sum + row[key].fp + row[key].tn, 0)) * 100, 2),
    whollyMissedUtterances: field(key, 'missedUtterances'),
    onsetMs: { p50: percentile(latencies, 50), p90: percentile(latencies, 90), max: percentile(latencies, 100) },
  };
};
console.log(JSON.stringify({
  model: { ...SILERO_VAD_5_1, threshold: VAD_THRESHOLD, energyThreshold, sessionInitMs: round(sessionInitMs, 2), firstFrameMs: round(firstFrameMs, 3) },
  corpus: { clips: corpus.clips.length, audioSeconds: round(audioSeconds, 3), speechSeconds: round(corpus.totals.speechMs / 1000, 3),
    nuisanceSeconds: round(corpus.totals.nuisanceMs / 1000, 3), nonSilentNuisanceSeconds: round(corpus.totals.nuisanceAudioMs / 1000, 3), binMs: corpus.scoring.binMs },
  summary: { energy: summary('energy'), silero: summary('neural') },
  warm: { repeats: REPEATS,
    energy: { wallRtf: round(timed.energy.wall / 1000 / audioSeconds, 6), cpuRtf: round(timed.energy.cpu / audioSeconds, 6) },
    silero: { wallRtf: round(timed.neural.wall / 1000 / audioSeconds, 6), cpuRtf: round(timed.neural.cpu / audioSeconds, 6) } },
  perClip: rows.map(row => ({ id: row.id, noise: row.noise, speechDb: row.speechDb, nuisanceDb: row.nuisanceDb,
    energy: { fp: row.energy.fp, fn: row.energy.fn, falseActivations: row.energy.falseActivations, onsetMs: Math.round(row.energy.latencies[0] ?? -1) },
    silero: { fp: row.neural.fp, fn: row.neural.fn, falseActivations: row.neural.falseActivations, onsetMs: Math.round(row.neural.latencies[0] ?? -1) } })),
}, null, 2));

// Consumer replay: exactly what the real dictation segmentation hands a decoder, and
// how much of it is material the corpus labels as non-speech.
const consumer = { energy: { calls: 0, seconds: 0, speechSeconds: 0 }, neural: { calls: 0, seconds: 0, speechSeconds: 0 } };
const settings = whisperSettings({ vad: { enabled: true } });
for (const clip of corpus.clips) {
  const wav = readFileSync(clipPath(clip));
  const speech = ms(clip.speechMs), nuisance = ms(clip.nuisanceMs);
  for (const [name, session] of [['energy', undefined], ['neural', await sileroSession(modelBytes, runtime)]]) {
    const tally = consumer[name];
    await transcribeWhisper(wav, settings, {}, async pcm => {
      tally.calls++; tally.seconds += pcm.length / VAD_RATE;
      // Which labeled material this chunk overlaps, in seconds.
      for (let at = 0; at < pcm.length; at += VAD_RATE / 20) {
        const t = at / VAD_RATE;
        if (!inside(t, speech)) continue;
        tally.speechSeconds += 1 / 20;
        if (inside(t, nuisance)) tally.nuisanceSeconds = (tally.nuisanceSeconds ?? 0) + 1 / 20;
      }
      return { result: '', segments: [] };
    }, session);
  }
}
console.log(JSON.stringify({ consumerReplay: { ...consumer, clipSeconds: round(audioSeconds, 3),
  labelSpeechSeconds: round(corpus.totals.speechMs / 1000, 3),
  energyKeptPct: round(consumer.energy.seconds / audioSeconds * 100, 2),
  sileroKeptPct: round(consumer.neural.seconds / audioSeconds * 100, 2),
  energySentNuisanceSeconds: round(consumer.energy.nuisanceSeconds ?? 0, 3),
  sileroSentNuisanceSeconds: round(consumer.neural.nuisanceSeconds ?? 0, 3) } }, null, 2));