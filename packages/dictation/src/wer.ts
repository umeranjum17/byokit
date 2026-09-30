import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { wav } from './text.ts';
import { transcribeWhisper, whisperSettings, type WhisperSettings, type WhisperRnResult, type WhisperRnDecodeOptions } from './whisper.ts';

const words = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
export function wordErrorRate(reference: string, hypothesis: string) {
  const r = words(reference), h = words(hypothesis);
  type Cell = { substitutions: number; deletions: number; insertions: number; errors: number };
  let row: Cell[] = Array.from({ length: h.length + 1 }, (_, insertions) => ({ substitutions: 0, deletions: 0, insertions, errors: insertions }));
  for (let i = 1; i <= r.length; i++) {
    const next: Cell[] = [{ substitutions: 0, deletions: i, insertions: 0, errors: i }];
    for (let j = 1; j <= h.length; j++) {
      if (r[i - 1] === h[j - 1]) { next.push({ ...row[j - 1] }); continue; }
      const candidates = [
        { ...row[j - 1], substitutions: row[j - 1].substitutions + 1, errors: row[j - 1].errors + 1 },
        { ...row[j], deletions: row[j].deletions + 1, errors: row[j].errors + 1 },
        { ...next[j - 1], insertions: next[j - 1].insertions + 1, errors: next[j - 1].errors + 1 },
      ];
      next.push(candidates.reduce((a, b) => a.errors <= b.errors ? a : b));
    }
    row = next;
  }
  const count = row[h.length];
  return { ...count, referenceWords: r.length, wer: r.length ? count.errors / r.length : count.errors ? null : 0 };
}

export type WerManifest = {
  clips: { id: string; category: 'clean' | 'noisy' | 'fast' | 'technical-names'; file: string; reference: string; sha256: string; source: string }[];
  profiles: { id: string; settings: WhisperSettings; model?: string }[];
};

async function cli(binary: string, model: string, dir: string, pcm: Int16Array, o: WhisperRnDecodeOptions, timeoutMs: number): Promise<WhisperRnResult> {
  const input = join(dir, 'input.wav'), output = join(dir, 'output');
  await writeFile(input, wav([pcm]));
  const args = ['-m', model, '-f', input, '-oj', '-of', output, '-t', String(o.maxThreads), '-l', o.language,
    '-bs', String(o.beamSize), '-bo', String(o.bestOf), '-tp', String(o.temperature), '-tpi', String(o.temperatureInc),
    '-ml', String(o.maxLen), '--prompt', o.prompt];
  // whisper.rn always starts each job with no_context=true. CLI defaults to it too.
  await new Promise<void>((accept, reject) => {
    const child = spawn(binary, args, { env: {}, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', timedOut = false, kill: ReturnType<typeof setTimeout> | undefined;
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(kill);
      if (timedOut) reject(new Error('Whisper fixture inference timed out'));
      else if (code !== 0) reject(new Error(`Whisper fixture inference exited ${code}: ${stderr}`));
      else accept();
    });
  });
  const data = JSON.parse(await readFile(`${output}.json`, 'utf8')) as {
    result?: { language?: string }; transcription: { text: string; offsets: { from: number; to: number } }[];
  };
  return { result: data.transcription.map(s => s.text.trim()).join(' '), language: data.result?.language,
    segments: data.transcription.map(s => ({ text: s.text, t0: s.offsets.from / 10, t1: s.offsets.to / 10 })) };
}

/** Explicit desktop CLI/model paths only; fixture bytes are integrity checked before inference. */
export async function runWer(o: { binary: string; model: string; manifest: string; profiles?: string[]; timeoutMs?: number }) {
  if (!isAbsolute(o.binary) || !isAbsolute(o.model) || !(Number.isFinite(o.timeoutMs ?? 120_000) && (o.timeoutMs ?? 120_000) > 0)) throw new Error('Pass absolute binary/model paths and a positive timeout');
  const manifestPath = resolve(o.manifest), manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WerManifest;
  if (!Array.isArray(manifest.clips) || !manifest.clips.length || !Array.isArray(manifest.profiles) || !manifest.profiles.length) throw new Error('Fixture manifest needs clips and profiles');
  const profiles = manifest.profiles.filter(p => !o.profiles || o.profiles.includes(p.id));
  if (!profiles.length || o.profiles?.some(id => !profiles.some(p => p.id === id))) throw new Error('Unknown settings profile');
  const clips = await Promise.all(manifest.clips.map(async clip => {
    const bytes = new Uint8Array(await readFile(resolve(dirname(manifestPath), clip.file)));
    if (createHash('sha256').update(bytes).digest('hex') !== clip.sha256) throw new Error(`Fixture checksum mismatch: ${clip.id}`);
    return { ...clip, bytes };
  }));
  const dir = await mkdtemp(join(tmpdir(), 'dictation-wer-'));
  try {
    const reports = [];
    for (const profile of profiles) {
      const settings = whisperSettings(profile.settings), model = profile.model ? resolve(dirname(manifestPath), profile.model) : o.model;
      const results = [];
      for (const clip of clips) {
        const start = performance.now();
        const transcript = await transcribeWhisper(clip.bytes, settings, {}, (pcm, decode) => cli(o.binary, model, dir, pcm, decode, o.timeoutMs ?? 120_000));
        const latencyMs = performance.now() - start;
        results.push({ id: clip.id, category: clip.category, reference: clip.reference, hypothesis: transcript.text,
          ...wordErrorRate(clip.reference, transcript.text), audioMs: transcript.durationMs!, latencyMs, realTimeFactor: latencyMs / transcript.durationMs! });
      }
      const totals = results.reduce((sum, r) => ({ errors: sum.errors + r.errors, referenceWords: sum.referenceWords + r.referenceWords,
        audioMs: sum.audioMs + r.audioMs, latencyMs: sum.latencyMs + r.latencyMs }), { errors: 0, referenceWords: 0, audioMs: 0, latencyMs: 0 });
      reports.push({ id: profile.id, model, settings, clips: results, summary: { ...totals, wer: totals.referenceWords ? totals.errors / totals.referenceWords : null,
        meanLatencyMs: totals.latencyMs / results.length, realTimeFactor: totals.audioMs ? totals.latencyMs / totals.audioMs : null } });
    }
    return { binary: o.binary, manifest: manifestPath, latencyBasis: 'wall clock including fresh CLI/model load for each chunk; not phone latency', profiles: reports };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
