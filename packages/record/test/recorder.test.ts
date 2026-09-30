import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { recorderMain, type RecorderTools } from '../src/recorder.ts';

function bench(mode = 'normal') {
  const dir = scratchDir('rec');
  const tool = join(dir, 'media');
  writeFileSync(tool, `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv.slice(2);
if(a.includes('-show_entries')) { console.log('0.8'); process.exit(0); }
const out = a.at(-1); fs.writeFileSync(out, 'video');
if(a.includes('x11grab')) {
 if(${JSON.stringify(mode)} === 'fail') process.exit(1);
 if(${JSON.stringify(mode)} !== 'pending') console.log('frame=1');
 const t = setTimeout(() => process.exit(0), 800);
 process.stdin.on('data', () => { clearTimeout(t); process.exit(0); });
} else { fs.writeFileSync(${JSON.stringify(join(dir, 'render-args'))}, JSON.stringify(a)); }
`, { mode: 0o700 });
  chmodSync(tool, 0o700);
  const tools: RecorderTools = { ffmpeg: tool, ffprobe: tool, platform: 'linux', env: {} };
  const root = join(dir, 'takes'), state = join(dir, 'state');
  mkdirSync(root); mkdirSync(state);
  const argv = ['capture', 'record', '--source', 'x11::99', '--root', root, '--state-dir', state, '--events', 'none', '--max-seconds', '2'];
  return { dir, tools, root, state, argv };
}
const call = async (argv: string[], tools: RecorderTools) => {
  const lines: Record<string, any>[] = [];
  const code = await recorderMain(argv, line => lines.push(JSON.parse(line)), tools);
  return { code, lines };
};

test('hello opens no media tool; unsupported and malformed calls fail before capture', async () => {
  const b = bench();
  const hello = await call(['capture', 'hello'], { ...b.tools, ffmpeg: '/missing', ffprobe: '/missing' });
  assert.equal(hello.code, 0);
  assert.deepEqual(hello.lines[0]?.sources, ['x11']);
  assert.equal((await call(['capture', 'hello'], { ...b.tools, platform: 'darwin' })).lines[0]?.error.code, 'unsupported-source');
  for (const source of ['screen', 'android:device']) {
    const args = [...b.argv]; args[3] = source;
    assert.equal((await call(args, b.tools)).lines[0]?.error.code, 'unsupported-source');
  }
  const bad = [...b.argv]; bad[9] = 'own';
  assert.equal((await call(bad, b.tools)).code, 2);
  assert.deepEqual(readdirSync(b.root), []);
});

test('records, stops by state, rejects overlap, cleans state, and passes render options', async () => {
  const b = bench();
  const lines: Record<string, any>[] = [];
  let resolveStart!: () => void;
  const start = new Promise<void>(resolve => { resolveStart = resolve; });
  const running = recorderMain(b.argv, line => { const e = JSON.parse(line); lines.push(e); if(e.event === 'recording') resolveStart(); }, b.tools);
  await start;
  assert.equal((await call(b.argv, b.tools)).lines[0]?.error.code, 'already-recording');
  assert.equal((await call(['capture', 'stop', '--state-dir', b.state], b.tools)).code, 0);
  assert.equal(await running, 0);
  assert.deepEqual(lines.map(e => e.event), ['recording', 'done']);
  assert.deepEqual(readdirSync(b.state), []);
  const take = lines[1]!.take as string;
  const before = readdirSync(take);
  const plan = await call(['capture', 'make', take, '--no-planner', '--plan-only'], b.tools);
  assert.equal(plan.lines[0]?.out, null); assert.deepEqual(readdirSync(take), before);
  const captions = join(b.dir, 'captions.json');
  writeFileSync(captions, JSON.stringify([{ t: 0, text: 'Umer starts here', d: 0.5 }]));
  const made = await call(['capture', 'make', take, '--no-planner', '--title', 'Umer demo', '--captions', captions, '--set', 'crf=20', '--set', 'preset=fast'], b.tools);
  assert.equal(made.code, 0); assert.equal(made.lines[0]?.out, join(take, 'video.mp4'));
  const args = JSON.parse(readFileSync(join(b.dir, 'render-args'), 'utf8')) as string[];
  assert.ok(args.includes('mov_text')); assert.ok(args.includes('title=Umer demo')); assert.ok(args.includes('20')); assert.ok(args.includes('fast'));
  assert.ok(!readdirSync(take).some(p => p.startsWith('.render-')));
  assert.equal((await call(['capture', 'make', take, '--no-planner', '--set', 'unknown=true'], b.tools)).code, 2);
  assert.equal((await call(['capture', 'stop', '--state-dir', b.state], b.tools)).lines[0]?.error.code, 'not-recording');
});

test('failed and stopped-before-frames recordings leave no take or active state', async () => {
  const failed = bench('fail');
  assert.equal((await call(failed.argv, failed.tools)).code, 1);
  assert.deepEqual(readdirSync(failed.root), []); assert.deepEqual(readdirSync(failed.state), []);
  const b = bench('pending');
  const running = call(b.argv, b.tools);
  await call(['capture', 'stop', '--state-dir', b.state], b.tools);
  assert.equal((await running).lines[0]?.error.code, 'capture-stopped');
  assert.deepEqual(readdirSync(b.root), []); assert.deepEqual(readdirSync(b.state), []);
});

test('missing takes and corrupt captions return protocol errors; failure preserves existing render', async () => {
  const b = bench();
  assert.equal((await call(['capture', 'make', '/not-a-take', '--no-planner'], b.tools)).lines[0]?.error.code, 'take-input');
  const recorded = await call(b.argv, b.tools);
  const take = recorded.lines.at(-1)!.take as string;
  writeFileSync(join(take, 'video.mp4'), 'previous');
  const bad = join(b.dir, 'bad.json'); writeFileSync(bad, '{}');
  assert.equal((await call(['capture', 'make', take, '--no-planner', '--captions', bad], b.tools)).code, 2);
  assert.equal((await call(['capture', 'make', take, '--no-planner'], { ...b.tools, ffmpeg: '/missing' })).lines[0]?.error.code, 'render-failed');
  assert.equal(readFileSync(join(take, 'video.mp4'), 'utf8'), 'previous');
});
