// Historical consumer replay for report comparison ONLY. Production never keeps/cuts at timestamps.
// Adapted from muxr scripts/dictation/benchDictation.mjs at 6a9419563d (Apache-2.0).
import type { BenchOptions, WhisperBench } from './whisper-bench.ts';

export type LegacyCandidate = {
  whisper: Omit<BenchOptions, 'audioCtx'> & { audioCtx?: number | 'fit' };
  live?: { readEverySeconds?: number; keepAfterSeconds?: number; silentLevel?: number; keptPromptChars?: number };
  final?: Omit<BenchOptions, 'audioCtx'> & { audioCtx?: number | 'fit' };
};

export async function replayLegacy(bench: WhisperBench, candidate: LegacyCandidate, pcm: Int16Array, speed: number) {
  const options = (base: LegacyCandidate['whisper'], count: number, kept = ''): BenchOptions => {
    const { audioCtx, prompt, ...rest } = base;
    return { ...rest, audioCtx: audioCtx === 'fit' ? Math.min(1500, Math.ceil(count / 16000 * 50) + 256) : audioCtx,
      prompt: [prompt, kept].filter(Boolean).join(' ') || undefined };
  };
  if (!candidate.live) {
    const result = await bench.read(pcm, options(candidate.whisper, pcm.length));
    return { text: result.result, waitMs: result.ms * speed, readings: 1 };
  }
  const { readEverySeconds = 1, keepAfterSeconds = 6, silentLevel = 0.06, keptPromptChars = 200 } = candidate.live;
  const levels: { value: number; end: number }[] = [];
  let total = 0, keptAt = 0, kept = '', readTo = 0, heard = '', readings = 0;
  type Flight = { from: number; to: number; result: Awaited<ReturnType<WhisperBench['read']>>; doneAt: number };
  // A mutable holder keeps async flight updates explicit to TypeScript's control-flow analysis.
  const flight: { current?: Flight } = {};
  const spokenAfter = (at: number) => levels.some(l => l.end > at && l.value >= silentLevel);
  const start = async (at: number) => {
    const from = keptAt, to = total;
    const result = await bench.read(pcm.slice(from, to), options(candidate.whisper, to - from, kept.slice(-keptPromptChars)));
    readings++;
    flight.current = { from, to, result, doneAt: at + result.ms * speed / 1000 };
  };
  const land = (recording: boolean) => {
    const { from, to, result } = flight.current!;
    const last = result.segments.at(-1);
    if (recording && to - from > keepAfterSeconds * 16000 && result.segments.length > 1 && last) {
      keptAt = from + Math.floor(last.t0 * 160);
      kept = [kept, ...result.segments.slice(0, -1).map(s => s.text.trim())].filter(Boolean).join(' ');
      heard = last.text.trim();
    } else heard = result.result;
    readTo = to; flight.current = undefined;
  };
  const follow = async (at: number) => {
    if (!flight.current && total - readTo >= readEverySeconds * 16000 && spokenAfter(readTo)) await start(at);
  };
  for (let at = 0; at < pcm.length; at += 1280) {
    const chunk = pcm.subarray(at, Math.min(pcm.length, at + 1280)), time = (at + chunk.length) / 16000;
    while (flight.current && flight.current.doneAt <= time) {
      const landedAt = flight.current.doneAt; land(true); await follow(landedAt);
    }
    total += chunk.length;
    const step = Math.max(1, Math.floor(chunk.length / 64));
    let sum = 0, count = 0;
    for (let i = 0; i < chunk.length; i += step) { sum += (chunk[i] / 32768) ** 2; count++; }
    levels.push({ value: Math.min(1, Math.sqrt(sum / count) * 4), end: total });
    await follow(time);
  }
  let waitMs = 0;
  if (flight.current) { waitMs = Math.max(0, flight.current.doneAt - pcm.length / 16000) * 1000; land(false); }
  const current = readTo > keptAt && !spokenAfter(readTo) && !candidate.final;
  if (!current && total > keptAt) {
    const result = await bench.read(pcm.slice(keptAt, total), options({ ...candidate.whisper, ...candidate.final }, total - keptAt, kept.slice(-keptPromptChars)));
    readings++; waitMs += result.ms * speed; heard = result.result;
  }
  return { text: [kept, heard].filter(Boolean).join(' '), waitMs, readings };
}
