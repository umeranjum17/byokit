// BK-C1: the fake recorder speaking recorder protocol v1 (docs/capability-kits.md 5.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { fakeRecorder } from '../src/testing/fake-recorder.ts';

function runHello(bin: string, args: string[] = ['capture', 'hello']) {
  return spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000 });
}

function readLines(stdout: string): unknown[] {
  return stdout.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

test('hello answers the default and merges script.hello', () => {
  const dir = scratchDir('capture-fake-hello');
  const fake = fakeRecorder({ dir });
  const first = runHello(fake.bin);
  assert.equal(first.status, 0);
  const hello = JSON.parse(first.stdout) as { protocol: number; recorder: { name: string }; sources: string[]; android: boolean; events: string[] };
  assert.equal(hello.protocol, 1);
  assert.equal(hello.recorder.name, 'fake-recorder');
  assert.deepEqual(hello.sources, ['screen', 'x11']);
  assert.equal(hello.android, false);
  assert.ok(hello.events.includes('none'));
  fake.script({ hello: { protocol: 1, recorder: { name: 'custom', version: '9.9.9' } } as never });
  const second = runHello(fake.bin);
  assert.match(second.stdout, /custom/);
  const invocations = fake.invocations();
  assert.ok(invocations.length >= 2);
  assert.deepEqual(invocations[0]?.argv.slice(0, 2), ['capture', 'hello']);
  assert.ok(typeof invocations[0]?.env['PATH'] === 'string');
});

test('record on screen prints consent-pending, recording and done with a take dir', async () => {
  const dir = scratchDir('capture-fake-record');
  const fake = fakeRecorder({ dir, script: { seconds: 1 } });
  const root = join(dir, 'takes');
  const stateDir = join(dir, 'state');
  const child = spawn(fake.bin, ['capture', 'record', '--source', 'screen', '--root', root, '--state-dir', stateDir, '--events', 'none', '--max-seconds', '5']);
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  const exit = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exit, 0);
  const lines = readLines(stdout) as Array<{ event: string; take?: string }>;
  assert.deepEqual(lines.map((l) => l.event), ['consent-pending', 'recording', 'done']);
  const take = lines[1]?.take as string;
  assert.ok(take.startsWith(root + '/'));
  assert.ok(existsSync(join(take, 'take.json')));
  const doc = JSON.parse(readFileSync(join(take, 'take.json'), 'utf8')) as { source: string };
  assert.equal(doc.source, 'screen');
});

test("record with consent no keeps nothing under --root", async () => {
  const dir = scratchDir('capture-fake-consent');
  const fake = fakeRecorder({ dir, script: { consent: 'no' } });
  const root = join(dir, 'takes');
  const stateDir = join(dir, 'state');
  const child = spawn(fake.bin, ['capture', 'record', '--source', 'screen', '--root', root, '--state-dir', stateDir, '--events', 'none', '--max-seconds', '5']);
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  const exit = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exit, 1);
  const lines = readLines(stdout) as Array<{ event?: string; error?: { code: string } }>;
  assert.equal(lines[0]?.event, 'consent-pending');
  assert.equal(lines[lines.length - 1]?.error?.code, 'consent-cancelled');
  assert.equal(existsSync(root), false);
});

test('record on x11 skips consent and the lock refuses a second recording', async () => {
  const dir = scratchDir('capture-fake-lock');
  const fake = fakeRecorder({ dir, script: { seconds: 5 } });
  const root = join(dir, 'takes');
  const stateDir = join(dir, 'state');
  const first = spawn(fake.bin, ['capture', 'record', '--source', 'x11::99', '--root', root, '--state-dir', stateDir, '--events', 'none', '--max-seconds', '30']);
  let firstOut = '';
  first.stdout.setEncoding('utf8');
  first.stdout.on('data', (chunk: string) => { firstOut += chunk; });
  const recording = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no recording line')), 10_000);
    first.stdout.on('data', () => {
      const lines = firstOut.split('\n').filter((l) => l.trim() !== '');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { event?: string };
          if (parsed.event === 'recording') { clearTimeout(timer); resolve(firstOut); return; }
        } catch { /* partial line */ }
      }
    });
  });
  assert.match(recording, /recording/);
  assert.doesNotMatch(firstOut, /consent-pending/);
  const second = spawnSync(fake.bin, ['capture', 'record', '--source', 'x11::99', '--root', root, '--state-dir', stateDir, '--events', 'none', '--max-seconds', '5'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(second.status, 1);
  assert.match(second.stdout, /already-recording/);
  first.kill('SIGTERM');
  await new Promise<number | null>((resolve) => first.on('close', resolve));
});

test('stop with nothing recording answers not-recording; stop signals a live one', async () => {
  const dir = scratchDir('capture-fake-stop');
  const fake = fakeRecorder({ dir, script: { seconds: 30 } });
  const idle = runHello(fake.bin, ['capture', 'stop', '--state-dir', join(dir, 'state')]);
  assert.equal(idle.status, 1);
  assert.match(idle.stdout, /not-recording/);
  const root = join(dir, 'takes');
  const stateDir = join(dir, 'state');
  const rec = spawn(fake.bin, ['capture', 'record', '--source', 'x11::99', '--root', root, '--state-dir', stateDir, '--events', 'none', '--max-seconds', '30']);
  let out = '';
  rec.stdout.setEncoding('utf8');
  rec.stdout.on('data', (chunk: string) => { out += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no recording')), 10_000);
    rec.stdout.on('data', () => { if (out.includes('"recording"')) { clearTimeout(timer); resolve(); } });
  });
  const stopped = spawnSync(fake.bin, ['capture', 'stop', '--state-dir', stateDir], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(stopped.status, 0);
  assert.match(stopped.stdout, /"stopping":true/);
  const exit = await new Promise<number | null>((resolve) => rec.on('close', resolve));
  assert.equal(exit, 0);
  assert.match(out, /"done"/);
});

test('make needs a take, estimates plan-only, writes mp4 and enforces caps and --set', () => {
  const dir = scratchDir('capture-fake-make');
  const fake = fakeRecorder({ dir, script: { seconds: 1 } });
  const root = join(dir, 'takes');
  const stateDir = join(dir, 'state');
  const missing = spawnSync(fake.bin, ['capture', 'make', join(root, 'nope'), '--no-planner'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /take-input/);
  const rec = spawnSync(fake.bin, ['capture', 'record', '--source', 'x11::99', '--root', root, '--state-dir', stateDir, '--events', 'none', '--max-seconds', '5'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(rec.status, 0);
  const take = (readLines(rec.stdout).find((l) => (l as { event?: string }).event === 'recording') as { take: string }).take;
  const plan = spawnSync(fake.bin, ['capture', 'make', take, '--plan-only', '--no-planner'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(plan.status, 0);
  const planned = JSON.parse(plan.stdout) as { out: null; planner: { planned_tokens: number } };
  assert.equal(planned.out, null);
  assert.equal(planned.planner.planned_tokens, 1000);
  assert.equal(existsSync(join(take, 'out')), false);
  const overCap = spawnSync(fake.bin, ['capture', 'make', take, '--planner-key-fd', '3', '--max-tokens', '1'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(overCap.status, 1);
  assert.match(overCap.stdout, /preflight-refused/);
  const captionsFile = join(dir, 'captions.json');
  writeFileSync(captionsFile, JSON.stringify([{ t: 0, text: 'Hi' }]));
  const made = spawnSync(fake.bin, ['capture', 'make', take, '--no-planner', '--title', 'T', '--captions', captionsFile], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(made.status, 0);
  const result = JSON.parse(made.stdout) as { out: string; planner: { input_tokens: number; usd: number } };
  assert.ok(result.out.endsWith('.mp4'));
  assert.ok(existsSync(result.out));
  assert.equal(statSync(result.out).isFile(), true);
  const doc = JSON.parse(readFileSync(join(take, 'take.json'), 'utf8')) as { title: string; captions: unknown };
  assert.equal(doc.title, 'T');
  assert.deepEqual(doc.captions, [{ t: 0, text: 'Hi' }]);
  const badSet = spawnSync(fake.bin, ['capture', 'make', take, '--no-planner', '--set', 'nope=1'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(badSet.status, 2);
  assert.match(badSet.stdout, /invalid-arguments/);
  fake.script({ makeError: { code: 'render-failed', message: 'nope' } });
  const errMade = spawnSync(fake.bin, ['capture', 'make', take, '--no-planner'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(errMade.status, 1);
  assert.match(errMade.stdout, /render-failed/);
});

test('corrupt prints not json and invocations carry argv, env, key and captions', async () => {
  const dir = scratchDir('capture-fake-inv');
  const fake = fakeRecorder({ dir, script: { corrupt: 'hello' } });
  const corrupt = runHello(fake.bin);
  assert.equal(corrupt.status, 0);
  assert.match(corrupt.stdout, /not json/);
  fake.script({});
  const root = join(dir, 'takes');
  const stateDir = join(dir, 'state');
  const rec = spawnSync(fake.bin, ['capture', 'record', '--source', 'x11::99', '--root', root, '--state-dir', stateDir, '--events', 'none', '--max-seconds', '5'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(rec.status, 0);
  const take = (readLines(rec.stdout).find((l) => (l as { event?: string }).event === 'recording') as { take: string }).take;
  const captionsFile = join(dir, 'c.json');
  writeFileSync(captionsFile, JSON.stringify([{ t: 0, text: 'Hi' }]));
  const keyed = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
    const keyedChild = spawn(fake.bin, ['capture', 'make', take, '--planner-key-fd', '3', '--max-tokens', '100000', '--captions', captionsFile], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let keyedOut = '';
    assert.ok(keyedChild.stdout !== null);
    keyedChild.stdout.setEncoding('utf8');
    keyedChild.stdout.on('data', (chunk: string) => { keyedOut += chunk; });
    keyedChild.on('error', reject);
    const fd3 = keyedChild.stdio[3];
    assert.ok(fd3 !== null && fd3 !== undefined);
    (fd3 as NodeJS.WritableStream).write('secret-key\n');
    (fd3 as NodeJS.WritableStream).end();
    keyedChild.on('close', (status) => resolve({ status, stdout: keyedOut }));
  });
  assert.equal(keyed.status, 0);
  const keyedResult = JSON.parse(keyed.stdout) as { planner: { input_tokens: number } };
  assert.equal(keyedResult.planner.input_tokens, 1000);
  const invocations = fake.invocations();
  assert.ok(invocations.length >= 3);
  const makes = invocations.filter((inv) => inv.argv.includes('make'));
  assert.ok(makes.length > 0);
  assert.ok(Array.isArray(makes[0]?.argv));
  assert.ok(typeof makes[0]?.env['PATH'] === 'string');
  const keyedMake = makes.find((inv) => inv.argv.includes('--captions'));
  assert.equal(keyedMake?.key, 'secret-key');
  assert.deepEqual(keyedMake?.captions, [{ t: 0, text: 'Hi' }]);
  assert.ok(!(keyedMake?.argv.join(' ') ?? '').includes('secret-key'));
  for (const value of Object.values(keyedMake?.env ?? {})) assert.ok(!value.includes('secret-key'));
  assert.ok(!readdirSync(dir).some((e) => e.includes('secret')));
});
