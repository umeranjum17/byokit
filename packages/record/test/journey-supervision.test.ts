// Consumer journeys for the supervision a recorder is held to, and for the bundled Linux recorder that is the
// default `bin`. An app supplies its own recorder bin, so the journeys write throwaway external-record shims to
// drive the caps, the timeout escalation to the whole process group and the wall-clock guard; the bundled backend
// is then driven through the built package as `new Capture({ stateDir })` does in the README.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Capture, CaptureError, CONSENT_WINDOW_S } from '@byokit/record';
import { fakeRecorder } from '@byokit/record/testing';

const code = (c: string) => (e: unknown) => e instanceof CaptureError && e.code === c;
const HELLO = "console.log(JSON.stringify({protocol:1,recorder:{name:'shim',version:'1'},sources:['x11'],android:false,events:['none'],planner:{available:false,needsKey:false}}));";

function shim(name: string, body: string): string {
  const bin = join(scratchDir('record-shim'), name);
  writeFileSync(bin, `#!${process.execPath}\nconst verb = process.argv[3];\n${body}\n`, { mode: 0o700 });
  return bin;
}

function benchBin(bin: string, timeoutMs?: number) {
  const dir = scratchDir('record-bin');
  const root = join(dir, 'takes');
  mkdirSync(root);
  const stateDir = join(dir, 'state');
  return { dir, root, stateDir, capture: new Capture({ bin, stateDir, ...(timeoutMs === undefined ? {} : { timeoutMs }) }) };
}

test('a recorder that floods, stalls or forks cannot flood or outlive the app', async () => {
  // 8 MB on stdout is too-much-output on any verb.
  const flood = shim('flood', "process.stdout.write('x'.repeat(9 * 1024 * 1024)); setInterval(() => {}, 1e6);");
  await assert.rejects(benchBin(flood).capture.hello(), code('too-much-output'));

  // A line over 64 KB on a recording is protocol.
  const long = shim('long', `if (verb === 'hello') { ${HELLO} } else { process.stdout.write('x'.repeat(65 * 1024) + '\\n'); setInterval(() => {}, 1e6); }`);
  const longBench = benchBin(long);
  await assert.rejects((async () => { for await (const _ of longBench.capture.record({ source: 'x11::99', root: longBench.root, maxSeconds: 60 })) void _; })(), code('protocol'));

  // stderr has no cap on a recording: 9 MB of it does not end the recording; a real cause rides in the failure tail.
  const chatty = shim('chatty', `if (verb === 'hello') { ${HELLO} } else { process.stderr.write('e'.repeat(9 * 1024 * 1024) + 'the-end'); console.log('{"event":"recording","take":"/r/t"}'); setTimeout(() => console.log('{"event":"done","take":"/r/t","seconds":1,"warnings":[]}'), 150); }`);
  const chattyBench = benchBin(chatty);
  const seen: string[] = [];
  for await (const e of chattyBench.capture.record({ source: 'x11::99', root: chattyBench.root, maxSeconds: 60 })) seen.push(e.event);
  assert.deepEqual(seen, ['recording', 'done']);

  const cause = shim('cause', `if (verb === 'hello') { ${HELLO} } else { process.stderr.write('the-real-cause\\n'); console.log('{"error":{"code":"internal","message":"boom"}}'); process.exit(1); }`);
  await assert.rejects(benchBin(cause).capture.make({ take: '/take-1' }), (e: unknown) =>
    code('failed')(e) && String((e as CaptureError).detail?.['stderrTail']).includes('the-real-cause'));

  // The wall-clock guard ends a recording that never finishes and drops the done it prints on the way down.
  const dir = scratchDir('record-guard');
  const fake = fakeRecorder({ dir: join(dir, 'recorder'), script: { seconds: 9999 } });
  const root = join(dir, 'takes');
  mkdirSync(root);
  const capture = new Capture({ bin: fake.bin, stateDir: join(dir, 'state') });
  await capture.hello();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const seen: string[] = [];
    const run = (async () => {
      for await (const e of capture.record({ source: 'x11::99', root, maxSeconds: 2 })) {
        seen.push(e.event);
        if (e.event === 'recording') mock.timers.tick((2 + CONSENT_WINDOW_S + 30) * 1000);
      }
    })();
    await assert.rejects(run, code('timeout'));
    assert.deepEqual(seen, ['recording']);
  } finally {
    mock.timers.reset();
  }
});

test('a timeout escalates from SIGTERM to SIGKILL against the whole recorder process group', async () => {
  const dir = scratchDir('record-group');
  const pids = join(dir, 'pids');
  const terms = join(dir, 'terms');
  const bin = shim('stubborn', `
if (verb === 'hello') { ${HELLO} }
else {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(terms)}, 'child\\n'));
  const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)"], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, g.pid]));
  setInterval(() => {}, 1e6);
}`);
  const b = benchBin(bin, 1000);
  const started = Date.now();
  await assert.rejects(b.capture.make({ take: join(b.dir, 'take-1') }), code('timeout'));
  const took = Date.now() - started;
  assert.ok(took >= 5_900 && took < 9_000, `took ${took} ms`);
  assert.equal(readFileSync(terms, 'utf8'), 'child\n', 'SIGTERM came first');
  const [child, grandchild] = JSON.parse(readFileSync(pids, 'utf8')) as number[];
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  for (let i = 0; i < 40 && !gone(grandchild!); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(gone(child!), 'child gone');
  assert.ok(gone(grandchild!), 'grandchild gone');
});

const bundled = process.platform === 'linux';
const hasFfmpeg = bundled && ['/usr/bin/ffmpeg', '/usr/bin/ffprobe'].every((p) => { try { accessSync(p); return true; } catch { return false; } });

test('the bundled recorder answers protocol v1, refuses a take it cannot open, and keeps a previous video when a render fails', { skip: !bundled, timeout: 60_000 }, async () => {
  const dir = scratchDir('record-bundled');
  const capture = new Capture({ stateDir: join(dir, 'state') });
  const hello = await capture.hello();
  assert.deepEqual(hello.sources, ['x11']);
  assert.equal(hello.events.includes('none'), true);
  assert.equal(hello.planner.available, false);
  assert.equal(await capture.stop(), 'not-recording');
  await assert.rejects(capture.make({ take: join(dir, 'takes', 'missing') }), code('take-input'));
  if (!hasFfmpeg) return;
  const take = join(dir, 'takes', 'take-1');
  mkdirSync(take, { recursive: true });
  writeFileSync(join(take, 'take.json'), JSON.stringify({ seconds: 1 }));
  writeFileSync(join(take, 'raw.mp4'), 'not a video');
  writeFileSync(join(take, 'video.mp4'), 'previous');
  await assert.rejects(capture.make({ take }), code('render-failed'));
  assert.equal(readFileSync(join(take, 'video.mp4'), 'utf8'), 'previous');
});
