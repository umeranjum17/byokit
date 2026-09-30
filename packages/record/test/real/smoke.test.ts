// No owner's display: allocate an isolated server using Xvfb's displayfd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Capture } from '../../src/index.ts';
import { captureContract } from '../../src/testing/index.ts';
import { scratchDir, trackChild } from '../../../test-support.ts';

const available = process.platform === 'linux' && ['/usr/bin/Xvfb', '/usr/bin/ffmpeg', '/usr/bin/ffprobe'].every(p => { try { accessSync(p); return true; } catch { return false; } });
test('bundled recorder captures private Xvfb, stops, makes a playable local MP4', { skip: !available, timeout: 120_000 }, async () => {
  const dir = scratchDir('r');
  const env = { HOME: dir, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  const x = trackChild(spawn('/usr/bin/Xvfb', ['-displayfd', '1', '-screen', '0', '640x360x24', '-nolisten', 'tcp'], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  const display = await Promise.race([
    new Promise<string>(resolve => { let s = ''; x.stdout!.on('data', b => { s += b.toString(); if(s.includes('\n')) resolve(`:${s.trim()}`); }); }),
    new Promise<never>((_, reject) => x.once('exit', () => reject(new Error('Xvfb exited before readiness')))),
  ]);
  try {
    const capture = new Capture({ stateDir: join(dir, 's') });
    assert.deepEqual((await capture.hello()).sources, ['x11']);
    const root = join(dir, 'takes'); mkdirSync(root);
    const events = [];
    for await (const e of capture.record({ source: `x11:${display}`, root, maxSeconds: 3 })) {
      events.push(e);
      if (e.event === 'recording') assert.equal(await capture.stop(), 'stopping');
    }
    assert.deepEqual(events.map(e => e.event), ['recording', 'done']);
    const done = events.at(-1)!; assert.equal(done.event, 'done');
    if (done.event !== 'done') throw new Error('Missing done');
    assert.ok(done.seconds > 0 && done.seconds <= 4);
    assert.deepEqual(readdirSync(join(dir, 's/capture/recorder')), []);
    assert.equal(await capture.stop(), 'not-recording');
    const plan = await capture.make({ take: done.take, planOnly: true }); assert.equal(plan.out, null);
    const made = await capture.make({ take: done.take, title: 'Umer records a demo', captions: [{ t: 0, text: 'Umer starts here', d: 0.1 }], set: { crf: 23, preset: 'ultrafast' } });
    assert.ok(made.out);
    const probe = spawnSync('/usr/bin/ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', made.out], { env, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const data = JSON.parse(probe.stdout);
    assert.ok(data.streams.some((s: { codec_name: string }) => s.codec_name === 'h264'));
    assert.ok(data.streams.some((s: { codec_name: string }) => s.codec_name === 'mov_text'));
    assert.equal(data.format.tags.title, 'Umer records a demo');
    assert.ok(readFileSync(made.out).length > 1000);
    // The same public conformance cases used for external recorders, on the real backend.
    const cases: Array<{ name: string; run: (t: { skip(message?: string): void }) => void | Promise<void> }> = [];
    captureContract(async () => ({ capture: new Capture({ stateDir: join(dir, 'contract') }), root, source: `x11:${display}` }),
      (name, run) => { if (!name.startsWith('*fake*')) cases.push({ name, run }); });
    for (const c of cases) await c.run({ skip() { throw new Error('Unexpected skip: ' + c.name); } });
    // Installed dist entry uses the same bundled recorder, without an executable shebang.
    const published = await import('../../dist/index.js');
    assert.deepEqual((await new published.Capture({ stateDir: join(dir, 'dist') }).hello()).sources, ['x11']);
  } finally {
    x.kill('SIGTERM'); await once(x, 'exit');
  }
});
