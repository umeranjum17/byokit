// This module is only activated through the kit's IPC child. Importing a packed entry does no work.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DictateError, type DictateOptions, type DictateTranscript, type DictateSegment } from './types.ts';
import type { AdapterConfig } from './node.ts';
type Request = { config: AdapterConfig; bytes: Uint8Array; options: DictateOptions; mime: string };
const controller = new AbortController();

function duration(bytes: Uint8Array): number {
  if (bytes.length < 44 || Buffer.from(bytes.subarray(0, 4)).toString() !== 'RIFF') return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = view.getUint32(28, true); return rate ? (bytes.length - 44) * 1000 / rate : 0;
}
function endpoint(c: AdapterConfig): string {
  const base = c.id === 'chatgpt' ? 'https://chatgpt.com/backend-api/transcribe' : c.id === 'openrouter' ? 'https://openrouter.ai/api/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
  if (!c.endpoint) return base;
  const u = new URL(c.endpoint);
  // A fake endpoint is loopback-only, so an arbitrary URL cannot exfiltrate a plan credential.
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.username || u.password) throw new DictateError('unsupported');
  return u.href;
}
async function http(r: Request): Promise<Omit<DictateTranscript, 'engine'>> {
  const c = r.config, o = r.options;
  if (!c.key) throw new DictateError(c.id === 'chatgpt' ? 'signed-out' : 'bad-key');
  const form = new FormData();
  const copy = new Uint8Array(r.bytes);
  form.set('file', new Blob([copy], { type: r.mime || 'audio/wav' }), `speech.${r.mime.includes('mpeg') ? 'mp3' : r.mime.includes('mp4') ? 'm4a' : r.mime.includes('webm') ? 'webm' : r.mime.includes('ogg') ? 'ogg' : r.mime.includes('flac') ? 'flac' : r.mime.includes('aac') ? 'aac' : 'wav'}`);
  if (c.id !== 'chatgpt') {
    form.set('model', c.model!);
    if (o.timestamps && o.timestamps !== 'none') {
      if (c.id === 'openai' && c.model !== 'whisper-1') throw new DictateError('unsupported');
      form.set('response_format', 'verbose_json'); form.append('timestamp_granularities[]', o.timestamps);
    } else form.set('response_format', 'json');
    if (o.languages?.[0]) form.set('language', o.languages[0]);
    const prompt = [o.prompt, ...(o.keywords ?? []), o.punctuation === false ? 'Do not add punctuation.' : undefined].filter(Boolean).join(' ');
    if (prompt) form.set('prompt', prompt);
  } else if (o.timestamps && o.timestamps !== 'none' || c.id === 'chatgpt' && o.languages?.length) throw new DictateError('unsupported');
  const headers: Record<string, string> = { authorization: `Bearer ${c.key}` };
  if (c.id === 'chatgpt') { headers.originator = 'byokit'; if (c.accountId) headers['chatgpt-account-id'] = c.accountId; }
  const url = endpoint(c);
  let response: Response;
  try { response = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal, redirect: 'error' }); }
  catch { throw new DictateError(controller.signal.aborted ? 'cancelled' : 'network'); }
  if (!response.ok) {
    const retry = Number(response.headers.get('retry-after'));
    throw new DictateError(response.status === 403 ? 'not-included' : response.status === 401 ? c.id === 'chatgpt' ? 'signed-out' : 'bad-key' : response.status === 429 ? 'rate-limited' : response.status === 413 ? 'too-large' : 'network', { until: retry > 0 ? Date.now() + retry * 1000 : undefined });
  }
  const data = await response.json() as { text?: string; language?: string; duration?: number; segments?: { id?: number; text: string; start: number; end: number }[]; words?: { word: string; start: number; end: number }[]; usage?: { cost?: number; input_tokens?: number; seconds?: number } };
  if (typeof data.text !== 'string') throw new DictateError('network');
  const words = data.words?.map(w => ({ text: w.word, startMs: w.start * 1000, endMs: w.end * 1000 }));
  const segments: DictateSegment[] = data.segments?.map((s, i) => ({ id: String(s.id ?? i), text: s.text.trim(), final: true, startMs: s.start * 1000, endMs: s.end * 1000, words: words?.filter(w => w.startMs >= s.start * 1000 && w.startMs < s.end * 1000) })) ?? [{ id: '0', text: data.text, final: true, words }];
  const audioMs = (data.duration ?? data.usage?.seconds) !== undefined ? (data.duration ?? data.usage?.seconds)! * 1000 : duration(r.bytes);
  return { text: data.text, segments, language: data.language, durationMs: audioMs, usage: { audioMs, basis: c.id === 'chatgpt' ? 'subscription' : 'minutes', costUsd: data.usage?.cost, inputTokens: data.usage?.input_tokens } };
}
async function whisper(r: Request): Promise<Omit<DictateTranscript, 'engine'>> {
  const dir = await mkdtemp(join(tmpdir(), 'dictate-'));
  try {
    const file = join(dir, 'audio.wav'), output = join(dir, 'text'); await writeFile(file, r.bytes);
    const args = ['-m', r.config.modelPath!, '-f', file, r.options.timestamps === 'word' ? '-ojf' : '-oj', '-of', output, '-t', String(r.config.threads), '-l', r.options.languages?.[0] ?? 'auto'];
    const prompt = [r.options.prompt, ...(r.options.keywords ?? []), r.options.punctuation === false ? 'Do not add punctuation.' : undefined].filter(Boolean).join(' ');
    if (prompt) args.push('--prompt', prompt);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(r.config.binary!, args, { env: {}, stdio: 'ignore' });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); };
      controller.signal.addEventListener('abort', abort, { once: true });
      child.once('close', () => { clearTimeout(killTimer); controller.signal.removeEventListener('abort', abort); });
      if (controller.signal.aborted) abort();
      child.once('error', () => reject(new DictateError(controller.signal.aborted ? 'cancelled' : 'bad-model')));
      child.once('close', code => code === 0 ? resolve() : reject(new DictateError(controller.signal.aborted ? 'cancelled' : 'bad-model')));
    });
    const data = JSON.parse(await readFile(`${output}.json`, 'utf8')) as { result?: { language?: string }; transcription: { text: string; offsets: { from: number; to: number }; tokens?: { text: string; offsets: { from: number; to: number } }[] }[] };
    const segments = data.transcription.map((s, i) => ({ id: String(i), text: s.text.trim(), final: true, startMs: s.offsets.from, endMs: s.offsets.to,
      words: r.options.timestamps === 'word' ? s.tokens?.map(w => ({ text: w.text, startMs: w.offsets.from, endMs: w.offsets.to })) : undefined }));
    return { text: segments.map(s => s.text).join(' '), segments, language: data.result?.language, durationMs: duration(r.bytes), usage: { audioMs: duration(r.bytes), basis: 'free' } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
if (process.send) {
  process.on('disconnect', () => controller.abort());
  let busy = false;
  process.on('message', async (r: Request & { cancel?: boolean }) => {
    if (r.cancel) { controller.abort(); return; }
    if (busy) return; busy = true;
    try {
      const result = await (r.config.id === 'whisper' ? whisper(r) : http(r));
      if (process.connected) process.send!({ result }, () => process.disconnect());
    } catch (error) {
      if (process.connected) process.send!({ code: error instanceof DictateError ? error.code : 'network', until: error instanceof DictateError ? error.until : undefined }, () => process.disconnect());
    }
  });
}
