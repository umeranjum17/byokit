// BK-C2: supervision (docs/capability-kits.md 5.4, D-G, D-K) over throwaway shims of its own, not the fake recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { CONSENT_WINDOW_S } from '../src/constants.ts';
import { CaptureError } from '../src/errors.ts';
import { recordGuardMs, recorderArgv, recorderEnv, runRecorder, streamRecorder } from '../src/supervise.ts';
import { fakeRecorder } from '../src/testing/fake-recorder.ts';

/** A Node script at <dir>/<name>, mode 0700, pinned to this Node. */
function shim(name: string, body: string): string {
  const bin = join(scratchDir('capture-shim'), name);
  writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return bin;
}

const code = (c: string) => (e: unknown) => e instanceof CaptureError && e.code === c;
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

const home = '/s/capture/home';
const base = {
  HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_STATE_HOME: `${home}/.local/state`, XDG_CACHE_HOME: `${home}/.cache`,
  XDG_DATA_HOME: `${home}/.local/share`, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
};
const display = {
  WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  HYPRLAND_INSTANCE_SIGNATURE: 'sig', XAUTHORITY: '/run/user/1000/xauth',
};

test('recorderEnv is built from nothing, with display variables only for the source that needs them', () => {
  assert.deepEqual(recorderEnv({ stateDir: '/s', display }), base);
  assert.deepEqual(recorderEnv({ stateDir: '/s', source: 'screen', display }), {
    ...base, WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', HYPRLAND_INSTANCE_SIGNATURE: 'sig',
  });
  assert.deepEqual(recorderEnv({ stateDir: '/s', source: 'screen', display: { WAYLAND_DISPLAY: 'wayland-1' } }), { ...base, WAYLAND_DISPLAY: 'wayland-1' });
  assert.deepEqual(recorderEnv({ stateDir: '/s', source: 'x11::99', display }), { ...base, DISPLAY: ':99', XAUTHORITY: '/run/user/1000/xauth' });
  assert.deepEqual(recorderEnv({ stateDir: '/s', source: 'x11::99' }), { ...base, DISPLAY: ':99' });
  assert.deepEqual(recorderEnv({ stateDir: '/s', source: 'android:emulator-5554', display }), base);
  process.env['WAYLAND_DISPLAY'] = 'from-the-parent';
  try { assert.equal(recorderEnv({ stateDir: '/s', source: 'screen' })['WAYLAND_DISPLAY'], undefined); } finally { delete process.env['WAYLAND_DISPLAY']; }
});

test('recorderArgv passes every flag as its own entry and rejects NUL', () => {
  const sd = '/s/capture/recorder';
  assert.deepEqual(recorderArgv('/s', { verb: 'hello' }), ['capture', 'hello']);
  assert.deepEqual(recorderArgv('/s', { verb: 'stop' }), ['capture', 'stop', '--state-dir', sd]);
  assert.deepEqual(recorderArgv('/s', { verb: 'record', o: { source: 'screen', root: '/r x', maxSeconds: 5 } }),
    ['capture', 'record', '--source', 'screen', '--root', '/r x', '--state-dir', sd, '--events', 'none', '--max-seconds', '5']);
  assert.deepEqual(recorderArgv('/s', { verb: 'make', o: { take: '/r/t', planOnly: true, title: '--no-planner', set: { speed: 1.5, loud: true } }, captionsFile: '/c.json' }),
    ['capture', 'make', '/r/t', '--plan-only', '--no-planner', '--title', '--no-planner', '--captions', '/c.json', '--set', 'speed=1.5', '--set', 'loud=true']);
  assert.deepEqual(recorderArgv('/s', { verb: 'make', o: { take: '/r/t', plannerKey: 'secret', maxTokens: 9 } }),
    ['capture', 'make', '/r/t', '--planner-key-fd', '3', '--max-tokens', '9']);
  assert.throws(() => recorderArgv('/s', { verb: 'make', o: { take: '/r/t', title: 'a\0b' } }), code('invalid'));
});

test('runRecorder rejects NUL in argv, a relative bin and a non-executable bin before spawning', async () => {
  const bin = shim('ok', "process.stdout.write('{}\\n');");
  await assert.rejects(runRecorder(bin, {}, ['capture', 'he\0llo'], { timeoutMs: 5_000 }), code('invalid'));
  await assert.rejects(runRecorder('recorder', {}, ['capture', 'hello'], { timeoutMs: 5_000 }), code('missing'));
  const plain = join(scratchDir('capture-plain'), 'recorder');
  writeFileSync(plain, '#!/bin/sh\n', { mode: 0o600 });
  await assert.rejects(runRecorder(plain, {}, ['capture', 'hello'], { timeoutMs: 5_000 }), code('missing'));
  await assert.rejects(runRecorder('/nonexistent/recorder', {}, ['capture', 'hello'], { timeoutMs: 5_000 }), code('missing'));
  assert.throws(() => streamRecorder('recorder', {}, ['capture', 'record'], { guardMs: 1_000 }), code('missing'));
  assert.throws(() => streamRecorder(bin, {}, ['capture', '\0'], { guardMs: 1_000 }), code('invalid'));
  const s = await runRecorder(bin, {}, ['capture', 'hello'], { timeoutMs: 5_000 });
  assert.deepEqual(s, { stdout: '{}\n', stderr: '', exitCode: 0, timedOut: false, aborted: false });
});

test('the spawned env is exactly the one passed: nothing from the parent', async () => {
  const bin = shim('env', 'process.stdout.write(JSON.stringify(process.env));');
  process.env['BYOKIT_PARENT_ONLY'] = 'leak';
  try {
    const s = await runRecorder(bin, { A: 'b' }, ['capture', 'hello'], { timeoutMs: 5_000 });
    assert.deepEqual(JSON.parse(s.stdout), { A: 'b' });
  } finally { delete process.env['BYOKIT_PARENT_ONLY']; }
});

test('8 MB per stream: past it the process is killed and the call rejects too-much-output', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const bin = shim('flood', `process.${stream}.write('x'.repeat(9 * 1024 * 1024)); setInterval(() => {}, 1e6);`);
    const started = Date.now();
    await assert.rejects(runRecorder(bin, {}, ['capture', 'make'], { timeoutMs: 60_000 }), code('too-much-output'));
    assert.ok(Date.now() - started < 10_000, stream);
  }
});

test('a record stdout line over 64 KB is protocol', async () => {
  const bin = shim('long', "process.stdout.write('x'.repeat(65 * 1024) + '\\n'); setInterval(() => {}, 1e6);");
  const s = streamRecorder(bin, {}, ['capture', 'record'], { guardMs: 60_000 });
  await assert.rejects((async () => { for await (const _ of s.lines) void _; })(), code('protocol'));
  assert.equal((await s.exited).guarded, false);
  const ok = shim('fits', "process.stdout.write('y'.repeat(64 * 1024) + '\\n');");
  const lines: string[] = [];
  for await (const line of streamRecorder(ok, {}, ['capture', 'record'], { guardMs: 60_000 }).lines) lines.push(line);
  assert.deepEqual(lines.map((l) => l.length), [64 * 1024]);
});

test('record stdout past 8 MB in total is too-much-output', async () => {
  const bin = shim('many', "const l = 'z'.repeat(1023) + '\\n'; for (let i = 0; i < 9 * 1024; i++) process.stdout.write(l); setInterval(() => {}, 1e6);");
  const s = streamRecorder(bin, {}, ['capture', 'record'], { guardMs: 60_000 });
  await assert.rejects((async () => { for await (const _ of s.lines) void _; })(), code('too-much-output'));
  await s.exited;
});

test('timeout: SIGTERM, then SIGKILL 5 s later to the whole group, grandchild included', async () => {
  const dir = scratchDir('capture-stubborn');
  const pids = join(dir, 'pids');
  const bin = shim('stubborn', `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(join(dir, 'terms'))}, 'child\\n'));
const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)"], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, g.pid]));
setInterval(() => {}, 1e6);`);
  const started = Date.now();
  const s = await runRecorder(bin, {}, ['capture', 'make'], { timeoutMs: 1_000 });
  const took = Date.now() - started;
  assert.equal(s.timedOut, true);
  assert.equal(s.exitCode, null);
  assert.ok(took >= 5_900 && took < 9_000, `took ${took} ms`);
  assert.equal(readFileSync(join(dir, 'terms'), 'utf8'), 'child\n', 'SIGTERM came first');
  const [child, grandchild] = JSON.parse(readFileSync(pids, 'utf8')) as number[];
  for (let i = 0; i < 40 && !gone(grandchild!); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(gone(child!), 'child gone');
  assert.ok(gone(grandchild!), 'grandchild gone');
});

test('an abort signal ends the call with aborted: true', async () => {
  const bin = shim('hang', 'setInterval(() => {}, 1e6);');
  const ac = new AbortController();
  const pending = runRecorder(bin, {}, ['capture', 'make'], { timeoutMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const s = await pending;
  assert.deepEqual([s.aborted, s.timedOut], [true, false]);
  const pre = new AbortController();
  pre.abort();
  assert.equal((await runRecorder(bin, {}, ['capture', 'make'], { timeoutMs: 60_000, signal: pre.signal })).aborted, true);
});

test('a record stderr flood of 9 MB does not end the recording; stderr keeps a 2 KB tail', async () => {
  const bin = shim('chatty', `
process.stderr.write('e'.repeat(9 * 1024 * 1024) + 'the-end');
process.stdout.write('{"event":"recording","take":"/r/t"}\\n');
setTimeout(() => process.stdout.write('{"event":"done","take":"/r/t","seconds":1,"warnings":[]}\\n'), 300);`);
  const s = streamRecorder(bin, {}, ['capture', 'record'], { guardMs: 60_000 });
  const lines: string[] = [];
  for await (const line of s.lines) lines.push(line);
  assert.equal(lines.length, 2);
  const r = await s.exited;
  assert.equal(r.exitCode, 0);
  assert.equal(r.guarded, false);
  assert.equal(r.stderr.length, 2048);
  assert.ok(r.stderr.endsWith('the-end'));
});

test('the wall-clock guard stops the stream and reports guarded: true within 7 s', async () => {
  const dir = scratchDir('capture-guard');
  const fake = fakeRecorder({ dir: join(dir, 'fake'), script: { seconds: 9999 } });
  const args = recorderArgv(dir, { verb: 'record', o: { source: 'x11::99', root: join(dir, 'takes'), maxSeconds: 3600 } });
  const started = Date.now();
  const s = streamRecorder(fake.bin, recorderEnv({ stateDir: dir, source: 'x11::99' }), args, { guardMs: 1_000 });
  const events: string[] = [];
  for await (const line of s.lines) events.push((JSON.parse(line) as { event: string }).event);
  const r = await s.exited;
  assert.ok(Date.now() - started < 7_000);
  assert.equal(r.guarded, true);
  assert.deepEqual(events, ['recording'], 'the done the fake printed on SIGTERM is dropped');
  assert.equal(recordGuardMs(2), (2 + CONSENT_WINDOW_S + 30) * 1000);
});

test('the planner key travels on fd 3 only', async () => {
  const bin = shim('key', `
const fs = require('node:fs');
let key = null; try { key = fs.readFileSync(3, 'utf8'); } catch {}
process.stdout.write(JSON.stringify({ key, argv: process.argv.slice(2), env: process.env }));`);
  const key = 'sk-fd3-only';
  const s = await runRecorder(bin, { HOME: '/h' }, ['capture', 'make', '/r/t', '--planner-key-fd', '3', '--max-tokens', '9'], { timeoutMs: 5_000, key });
  const seen = JSON.parse(s.stdout) as { key: string; argv: string[]; env: Record<string, string> };
  assert.equal(seen.key, key);
  assert.ok(!JSON.stringify(seen.argv).includes(key));
  assert.ok(!JSON.stringify(seen.env).includes(key));
  const without = JSON.parse((await runRecorder(bin, {}, ['capture', 'make', '/r/t', '--no-planner'], { timeoutMs: 5_000 })).stdout) as { key: string | null };
  assert.equal(without.key, null);
});
