// Bundled protocol-v1 backend. Media tools are injectable for offline tests.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Caption } from './types.ts';

export type RecorderTools = { ffmpeg: string; ffprobe: string; platform: string; env: Record<string, string> };
class RecorderFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const fail = (code: string, message: string): never => { throw new RecorderFailure(code, message); };
const json = (value: unknown, output: (line: string) => void) => output(JSON.stringify(value));
const path = (value: string | undefined): string => {
  if (!value || !isAbsolute(value) || value.includes('\0')) fail('invalid-arguments', 'Expected an absolute path');
  return value!;
};

async function command(bin: string, args: string[], tools: RecorderTools, cwd?: string): Promise<string> {
  const child = spawn(bin, args, { env: tools.env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', tail = '';
  let overflow = false;
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    if (out.length > 8 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); }
  });
  child.stderr.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2048); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => code === 0 && !overflow ? resolve() : reject(new Error(tail || 'Media tool failed')));
    });
    return out;
  } finally { clearTimeout(timer); }
}

function parse(argv: string[]): { verb: string; take?: string; flags: Map<string, string[]> } {
  if (argv[0] !== 'capture' || !argv[1]) fail('invalid-arguments', 'Expected capture and a verb');
  const verb = argv[1]!;
  const args = argv.slice(2);
  const take = verb === 'make' ? path(args.shift()) : undefined;
  const flags = new Map<string, string[]>();
  const allowed = verb === 'record' ? ['source', 'root', 'state-dir', 'events', 'max-seconds']
    : verb === 'stop' ? ['state-dir'] : verb === 'make' ? ['plan-only', 'no-planner', 'title', 'captions', 'set'] : [];
  while (args.length) {
    const flag = args.shift()!;
    if (!flag.startsWith('--')) fail('invalid-arguments', 'Expected a flag');
    const key = flag.slice(2);
    if (!allowed.includes(key)) fail('invalid-arguments', 'Unknown flag');
    const value = ['plan-only', 'no-planner'].includes(key) ? 'true' : args.shift();
    if (value === undefined || value.includes('\0') || (key !== 'set' && flags.has(key))) fail('invalid-arguments', 'Invalid flag value');
    flags.set(key, [...(flags.get(key) ?? []), value!]);
  }
  return { verb, ...(take ? { take } : {}), flags };
}

async function record(flags: Map<string, string[]>, tools: RecorderTools, output: (line: string) => void): Promise<void> {
  const get = (key: string) => flags.get(key)?.[0];
  const source = get('source');
  if (tools.platform !== 'linux' || !source?.startsWith('x11:')) fail('unsupported-source', 'This recorder supports Linux X11 video only');
  if (!/^:\d{1,4}(\.\d{1,2})?$/.test(source!.slice(4))) fail('invalid-arguments', 'Invalid X11 display');
  const seconds = Number(get('max-seconds'));
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600 || get('events') !== 'none') fail('invalid-arguments', 'Invalid duration or event mode');
  const root = path(get('root')), state = path(get('state-dir'));
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, 'active');
  try { mkdirSync(lock, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('already-recording', 'A recording is already active');
    throw e;
  }
  let take: string | undefined;
  let started = false;
  let succeeded = false;
  let stopping = false;
  let media: ReturnType<typeof spawn> | undefined;
  let killer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    media?.stdin?.end('q\n');
    killer = setTimeout(() => media?.kill('SIGKILL'), 5000);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const poll = setInterval(() => { if (existsSync(join(lock, 'stop'))) stop(); }, 50);
  const deadline = setTimeout(stop, seconds * 1000);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    take = mkdtempSync(join(root, 'take-'));
    media = spawn(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-framerate', '15',
      '-i', source!.slice(4), '-t', String(seconds), '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-progress', 'pipe:1', join(take, 'raw.mp4')],
    { env: tools.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let progress = '', tail = '';
    media.stdin?.on('error', () => {});
    media.stdout?.on('data', (chunk: Buffer) => {
      progress = (progress + chunk.toString()).slice(-4096);
      if (!started && !stopping && /frame=\s*[1-9]\d*\b/.test(progress)) {
        started = true;
        json({ event: 'recording', take }, output);
      }
    });
    media.stderr?.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2048); });
    const code = await new Promise<number | null>((resolve, reject) => {
      media!.on('error', reject); media!.on('close', resolve);
    });
    if (!started && stopping) fail('capture-stopped', 'Stopped before frames arrived');
    if (code !== 0 || !started) fail('internal', tail || 'No frames arrived');
    const duration = Number((await command(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', join(take, 'raw.mp4')], tools)).trim());
    if (!Number.isFinite(duration) || duration <= 0 || duration > seconds + 1) fail('internal', 'Invalid recorded duration');
    writeFileSync(join(take, 'take.json'), JSON.stringify({ seconds: duration }), { mode: 0o600 });
    succeeded = true;
    json({ event: 'done', take, seconds: duration, warnings: [] }, output);
  } finally {
    clearInterval(poll); clearTimeout(deadline); clearTimeout(killer);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    media?.kill('SIGKILL');
    rmSync(lock, { recursive: true, force: true });
    if (!succeeded && take) rmSync(take, { recursive: true, force: true });
  }
}

const timestamp = (seconds: number): string => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
async function make(take: string, flags: Map<string, string[]>, tools: RecorderTools, output: (line: string) => void): Promise<void> {
  let seconds: number;
  try {
    seconds = (JSON.parse(readFileSync(join(take, 'take.json'), 'utf8')) as { seconds: number }).seconds;
    if (!Number.isFinite(seconds) || seconds <= 0 || !statSync(join(take, 'raw.mp4')).isFile()) throw new Error();
  } catch { return fail('take-input', 'The take cannot be opened'); }
  if (!flags.has('no-planner')) fail('invalid-arguments', 'This recorder has no planner');
  const settings: string[] = [];
  for (const entry of flags.get('set') ?? []) {
    const [key, value, extra] = entry.split('=');
    if (extra !== undefined) fail('invalid-arguments', 'Invalid render setting');
    if (key === 'crf' && /^(\d|[1-4]\d|5[01])$/.test(value ?? '')) settings.push('-crf', value!);
    else if (key === 'preset' && ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(value ?? '')) settings.push('-preset', value!);
    else fail('invalid-arguments', 'Unknown render setting or value');
  }
  let captions: Caption[] = [];
  if (flags.has('captions')) {
    try { captions = JSON.parse(readFileSync(path(flags.get('captions')![0]), 'utf8')) as Caption[]; } catch { fail('invalid-arguments', 'Invalid captions'); }
    if (!Array.isArray(captions) || captions.some(c => !c || typeof c.text !== 'string' || /[\0\r\n]/.test(c.text) || !Number.isFinite(c.t) || c.t < 0 || c.t >= seconds || (c.d !== undefined && (!Number.isFinite(c.d) || c.d <= 0)))) fail('invalid-arguments', 'Invalid caption timing or text');
  }
  const result = { out: null as string | null, seconds, beats: 1, planner: { planned_tokens: 0, input_tokens: 0, usd: 0, failed: false }, warnings: [] };
  if (flags.has('plan-only')) { json(result, output); return; }
  const work = mkdtempSync(join(take, '.render-'));
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', join(take, 'raw.mp4')];
    if (captions.length) {
      const sub = join(work, 'captions.srt');
      writeFileSync(sub, captions.map((c, i) => `${i + 1}\n${timestamp(c.t)} --> ${timestamp(Math.min(seconds, c.t + (c.d ?? 2)))}\n${c.text}\n`).join('\n'), { mode: 0o600 });
      args.push('-protocol_whitelist', 'file,pipe', '-i', sub, '-map', '0:v:0', '-map', '1:0', '-c:s', 'mov_text');
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...settings, '-an');
    if (flags.has('title')) args.push('-metadata', `title=${flags.get('title')![0]}`);
    const out = join(work, 'video.mp4');
    args.push('-movflags', '+faststart', out);
    try { await command(tools.ffmpeg, args, tools); } catch { fail('render-failed', 'The video could not be made'); }
    // Keep a previously successful render if a later render fails.
    result.out = join(take, 'video.mp4');
    renameSync(out, result.out);
    json(result, output);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Test seam: every media tool and environment is supplied, never taken from the host. */
export async function recorderMain(argv: string[], output: (line: string) => void, tools: RecorderTools): Promise<number> {
  try {
    const { verb, take, flags } = parse(argv);
    if (verb === 'hello') {
      if (tools.platform !== 'linux') fail('unsupported-source', 'The bundled recorder requires Linux');
      json({ protocol: 1, recorder: { name: 'byokit-recorder', version: '0.2.0' }, sources: ['x11'], android: false, events: ['none'], planner: { available: false, needsKey: false } }, output);
    } else if (verb === 'record') await record(flags, tools, output);
    else if (verb === 'make') await make(take!, flags, tools, output);
    else if (verb === 'stop') {
      const lock = join(path(flags.get('state-dir')?.[0]), 'active');
      if (!existsSync(lock)) fail('not-recording', 'No recording is active');
      try { writeFileSync(join(lock, 'stop'), '', { mode: 0o600 }); } catch { fail('not-recording', 'Recording has ended'); }
      json({ stopping: true }, output);
    } else fail('invalid-arguments', 'Unknown verb');
    return 0;
  } catch (error) {
    const code = error instanceof RecorderFailure ? error.code : 'internal';
    json({ error: { code, message: error instanceof Error ? error.message : 'Recorder failed' } }, output);
    return code === 'invalid-arguments' ? 2 : 1;
  }
}
