// K6: `adopt` mode passes the app's env and PATH through to `cli()`/`terminal()`, and a terminal session can be
// paused so a slow consumer holds the Herdr child back instead of buffering in the host. Against the kit fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HerdrKit } from '../src/kit.ts';
import { writeBinShim } from '../src/testing/index.ts';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'herdr-k6-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const until = async (ok: () => boolean, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('adopt cli() runs a #!/usr/bin/env node bin when `path` has node, and passes `env` through', async () => {
  const fake = join(dir, 'fake');
  writeBinShim({ dir: fake, socketPath: join(dir, 'herdr.sock') });
  const bin = join(dir, 'herdr-env-node');
  const envOut = join(dir, 'env.json');
  // Records the env it got, then answers through the kit fake's bin.
  await writeFile(bin, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(envOut)}, JSON.stringify(process.env));
require('node:child_process').execFileSync(${JSON.stringify(join(fake, 'herdr'))}, process.argv.slice(2), { stdio: 'inherit' });
`, { mode: 0o700 });
  const env = { HOME: join(dir, 'home'), HERDR_CLIENT_SOCKET_PATH: join(dir, 'client.sock'), HERDR_SESSION: 'k6' };
  const kit = new HerdrKit({ mode: 'adopt', bin, socketPath: join(dir, 'herdr.sock'), path: [dirname(process.execPath), '/usr/bin', '/bin'], env });
  const r = await kit.cli(['--version']);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /^herdr \d+\.\d+\.\d+/);
  const seen = JSON.parse(await readFile(envOut, 'utf8')) as Record<string, string>;
  assert.equal(seen.PATH, `${dirname(process.execPath)}:/usr/bin:/bin`);
  for (const [k, v] of Object.entries(env)) assert.equal(seen[k], v, `${k} passes through`);
  assert.equal(seen.HERDR_SOCKET_PATH, join(dir, 'herdr.sock'));
});

test('a paused terminal holds the stream back to a fixed backlog, and resume() delivers every frame in order', async (t) => {
  const bin = writeBinShim({ dir: join(dir, 'fake-term'), socketPath: join(dir, 'herdr.sock') });
  const kit = new HerdrKit({ mode: 'adopt', bin, socketPath: join(dir, 'herdr.sock') });
  const s = kit.terminal('w1:p1', { mode: 'observe', cols: 80, rows: 24 });
  t.after(() => s.close());   // a failed assertion must not leave a blocked child holding the run open
  const data: string[] = [];
  s.onFrame((line) => {
    const frame = JSON.parse(line) as { type: string; data?: string };
    if (frame.type === 'terminal.frame') data.push(frame.data!);
  });
  await s.ready;

  const count = 4096;
  const size = 1024;
  const progress = join(dir, 'progress');
  const frameBytes = Buffer.byteLength(`${JSON.stringify({ type: 'terminal.frame', pane_id: 'w1:p1', data: `${count}:${'x'.repeat(size)}` })}\n`);
  s.pause();
  s.send(JSON.stringify({ type: 'fake.stream', count, size, progress }));
  const written = () => { try { return Number(readFileSync(progress, 'utf8')) || 0; } catch { return 0; } };
  await until(() => written() > 0, 'the stream to start');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(data.length, 0, 'no frame is delivered while paused');
  const heldAt = written();   // the child is blocked on the pipe by now, so the file is stable
  assert.ok(heldAt > 0, 'the child wrote before blocking');
  assert.ok(heldAt < count, `the child is held back (${heldAt}/${count} frames written)`);
  // What the child wrote sits in the kernel pipe (64 KiB) or was read by the kit before it stopped: Node's stream
  // highWaterMark (64 KiB) plus one in-flight read (64 KiB). A fixed ceiling, however long the stream runs.
  assert.ok(heldAt * frameBytes <= 4 * 64 * 1024, `backlog ${heldAt * frameBytes} bytes exceeds 256 KiB`);

  s.resume();
  await until(() => data.length === count, `${count} frames`);
  assert.deepEqual(data.map((d) => Number(d.slice(0, d.indexOf(':')))), Array.from({ length: count }, (_, i) => i));
  s.close();
  await s.exited;
});

test('pause()/resume() inside a handler keeps every handler in frame order', async (t) => {
  const bin = writeBinShim({ dir: join(dir, 'fake-nest'), socketPath: join(dir, 'herdr.sock') });
  const s = new HerdrKit({ mode: 'adopt', bin, socketPath: join(dir, 'herdr.sock') })
    .terminal('w1:p1', { mode: 'observe', cols: 80, rows: 24 });
  t.after(() => s.close());
  const seen: number[] = [];
  s.onFrame(() => { s.pause(); s.resume(); });
  s.onFrame((line) => {
    const frame = JSON.parse(line) as { type: string; data?: string };
    if (frame.type === 'terminal.frame') seen.push(Number(frame.data!.slice(0, frame.data!.indexOf(':'))));
  });
  await s.ready;
  s.send(JSON.stringify({ type: 'fake.stream', count: 2000, size: 64 }));
  await until(() => seen.length === 2000, '2000 frames');
  assert.deepEqual(seen, Array.from({ length: 2000 }, (_, i) => i));
});

test('close() while paused still settles exited', async () => {
  const bin = writeBinShim({ dir: join(dir, 'fake-close'), socketPath: join(dir, 'herdr.sock') });
  const s = new HerdrKit({ mode: 'adopt', bin, socketPath: join(dir, 'herdr.sock') })
    .terminal('w1:p1', { mode: 'control', cols: 80, rows: 24 });
  await s.ready;
  s.pause();
  s.send(JSON.stringify({ type: 'fake.stream', count: 4096, size: 1024 }));
  await new Promise((r) => setTimeout(r, 200));
  s.close();
  assert.equal((await s.exited).code, null);
});
