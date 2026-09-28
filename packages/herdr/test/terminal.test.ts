// H4 acceptance (docs/runtime-kits.md §11.3): openTerminal against a test-written shim — control carries
// --takeover and observe does not, ready rejects on ENOENT and on exit-before-output with the stderr tail,
// and frames pass through byte-identical.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openTerminal } from '../src/terminal.ts';
import { makeShim, type Shim } from './shim.ts';

let shim: Shim;
before(async () => { shim = await makeShim(); });
after(async () => { await shim?.dispose(); });

const env = { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin', HERDR_SOCKET_PATH: '/tmp/herdr.sock' };

test('control passes --takeover; observe does not; cols/rows land as argv', async () => {
  const control = openTerminal(shim.bin, { ...env, SHIM_OUT: shim.out }, 'w1:p1',
    { mode: 'control', cols: 120, rows: 40 });
  await control.ready;
  assert.deepEqual((await control.exited).code, 0);
  assert.deepEqual(JSON.parse(await readFile(shim.out, 'utf8')).argv,
    ['terminal', 'session', 'control', 'w1:p1', '--takeover', '--cols', '120', '--rows', '40']);

  const observe = openTerminal(shim.bin, { ...env, SHIM_OUT: shim.out }, 'w1:p2',
    { mode: 'observe', cols: 100, rows: 30 });
  await observe.ready;
  assert.deepEqual((await observe.exited).code, 0);
  assert.deepEqual(JSON.parse(await readFile(shim.out, 'utf8')).argv,
    ['terminal', 'session', 'observe', 'w1:p2', '--cols', '100', '--rows', '30']);
});

test('ready rejects on ENOENT with the missing/binary code', async () => {
  const s = openTerminal(join(shim.dir, 'nope'), env, 'w1:p1', { mode: 'observe', cols: 80, rows: 24 });
  await assert.rejects(s.ready, (e: NodeJS.ErrnoException) =>
    e.code === 'missing/binary' && /missing\/binary/.test(e.message));
  assert.equal((await s.exited).code, null);
});

test('ready rejects on exit before output, with the stderr tail; exited carries the code', async () => {
  const s = openTerminal(shim.bin, { ...env, SHIM_MODE: 'die' }, 'w1:p1', { mode: 'control', cols: 80, rows: 24 });
  await assert.rejects(s.ready, /boom: bad args/);
  const x = await s.exited;
  assert.equal(x.code, 3);
  assert.match(x.stderrTail, /boom: bad args/);
});

test('frames pass through byte-identical; send echoes back as frames; onFrame can unsubscribe', async () => {
  const s = openTerminal(shim.bin, { ...env, SHIM_MODE: 'frames' }, 'w1:p1', { mode: 'control', cols: 80, rows: 24 });
  await s.ready;

  const frames: string[] = [];
  const off = s.onFrame((f) => frames.push(f));
  let echoes = 0;
  const countEcho = s.onFrame((f) => { if (f.startsWith('echo:')) echoes++; });

  s.send('go');
  s.send('echo me');
  const deadline = Date.now() + 5_000;
  while (frames.length < 3 || echoes < 1) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for frames, got ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  countEcho();
  // The exact bytes between newlines, unmodified: a stray \r survives, quotes/backslashes/emoji survive.
  assert.deepEqual(frames, ['crlf stays\r', '{"emoji":"🚿 \\"quoted\\" \\\\ done"}', 'echo:echo me']);

  off();
  s.send('echo gone');
  const deadline2 = Date.now() + 500;
  while (Date.now() < deadline2 && frames.length < 4) await new Promise((r) => setTimeout(r, 10));
  assert.equal(frames.length, 3, 'a removed onFrame listener stops receiving frames');

  s.close();
  assert.equal((await s.exited).code, null, 'SIGTERM close reports a null exit code');
  s.send('after exit');   // must not throw or crash the host
});
