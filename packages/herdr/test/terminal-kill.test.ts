// `kit.terminal().close()` journeys: SIGTERM first, SIGKILL after the grace period when the child
// ignores it, and `exited` settles in both cases (issue 404: a TERM-trapping herdr leaked memory).
// The fake herdr binary writes its pid, emits one `terminal.ready` frame and either traps SIGTERM
// or dies cooperatively on it. The trap registers before the ready frame, so a close() that races
// the child's startup still hits a registered handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};

const fakeBin = (dir: string, trap: boolean): string => {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, trap ? 'herdr-trap' : 'herdr');
  const pidFile = JSON.stringify(join(dir, 'pid'));
  const termFile = JSON.stringify(join(dir, 'sigterm'));
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
${trap ? `process.on('SIGTERM', () => { fs.writeFileSync(${termFile}, '1'); });` : ''}
fs.writeFileSync(${pidFile}, String(process.pid));
process.stdout.write(JSON.stringify({ type: 'terminal.ready' }) + '\\n');
setInterval(() => {}, 1000);
`, { encoding: 'utf8', mode: 0o700 });
  chmodSync(bin, 0o700);
  return bin;
};

test('terminal close() ends a child that traps SIGTERM, after the grace period', async () => {
  const dir = scratchDir('terminal-kill');
  const kit = new HerdrKit({ mode: 'adopt', bin: fakeBin(dir, true), socketPath: join(dir, 'unused.sock') });
  const t = kit.terminal('p1', { mode: 'observe', cols: 80, rows: 24, killGraceMs: 300 });
  await t.ready;
  const pid = parseInt(readFileSync(join(dir, 'pid'), 'utf8'), 10);
  assert.ok(alive(pid));
  const started = Date.now();
  t.close();
  const exited = await t.exited;
  assert.ok(Date.now() - started < 300 + 1000, `exited took ${Date.now() - started}ms`);
  assert.equal(exited.code, null);                 // ended by signal, not an exit code
  assert.ok(existsSync(join(dir, 'sigterm')));     // SIGTERM arrived first and was ignored
  assert.ok(!alive(pid));                          // the pid is gone (kill -0 fails)
});

test('terminal close() settles exited when the child exits on SIGTERM alone', async () => {
  const dir = scratchDir('terminal-kill-coop');
  const kit = new HerdrKit({ mode: 'adopt', bin: fakeBin(dir, false), socketPath: join(dir, 'unused.sock') });
  const t = kit.terminal('p1', { mode: 'observe', cols: 80, rows: 24 });
  await t.ready;
  const pid = parseInt(readFileSync(join(dir, 'pid'), 'utf8'), 10);
  const started = Date.now();
  t.close();
  await t.exited;
  assert.ok(Date.now() - started < 1000, `exited took ${Date.now() - started}ms`);   // no grace wait
  assert.ok(!alive(pid));
});
