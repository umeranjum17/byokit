// Persistence across a real process boundary: a child process (its own umask, HOME and TMPDIR, nothing
// inherited from this test, no fd9) queues and cancels messages, exits, and this process reopens the same
// store and drains it. The fake sender is the only transport either side ever sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir, trackChild } from '../../test-support.ts';
import { Outbox } from '../src/index.ts';
import type { OutboxSendJob, OutboxSender } from '../src/index.ts';

const childProgram = (stateDir: string, entry: string) => `
process.umask(0o022);
const { statSync } = await import('node:fs');
const { Outbox } = await import(${JSON.stringify(entry)});
const outbox = await Outbox.open({ stateDir: ${JSON.stringify(stateDir)} });
const keep = await outbox.enqueue({ kind: 'email-reply', payload: { body: 'written by the child' } });
const gone = await outbox.enqueue({ kind: 'email-reply', payload: { body: 'taken back by the child' } });
const cancelled = await outbox.cancel(gone.id, { revision: gone.revision });
if (!cancelled.ok) throw new Error('child cancel lost before any send');
await outbox.close();
console.log(JSON.stringify({
  pid: process.pid,
  ids: [keep.id, gone.id],
  fileMode: statSync(${JSON.stringify(join(stateDir, 'outbox', 'entries.json'))}).mode & 0o777,
  dirMode: statSync(${JSON.stringify(join(stateDir, 'outbox'))}).mode & 0o777,
}));
`;

test('a restarted process reopens the store exactly as the child left it', async () => {
  const dir = scratchDir('outbox-restart');
  const home = join(dir, 'child-home');
  const tmp = join(dir, 'child-tmp');
  mkdirSync(home); mkdirSync(tmp);
  const guard = new URL('../../../scripts/test-egress-guard.cjs', import.meta.url).pathname;
  const entry = new URL('../src/index.ts', import.meta.url).href;
  const program = childProgram(dir, entry);
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '--require', guard, '-e', program], {
    cwd: dir,
    env: { HOME: home, TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let out = '';
  child.stdout!.on('data', (chunk) => { out += chunk; });
  let err = '';
  child.stderr!.on('data', (chunk) => { err += chunk; });
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(err, '');
  assert.equal(status.code, 0);
  const facts = JSON.parse(out.trim().split('\n').at(-1)!) as { pid: number; ids: string[]; fileMode: number; dirMode: number };
  assert.notEqual(facts.pid, process.pid); // written by another process, for real
  assert.equal(facts.fileMode, 0o600);
  assert.equal(facts.dirMode, 0o700);

  const calls: OutboxSendJob[] = [];
  const sender: OutboxSender = { send: (job) => { calls.push(job); return Promise.resolve({ accepted: true }); } };
  const outbox = await Outbox.open({ stateDir: dir, sender });
  const [keep, gone] = facts.ids.map((id) => outbox.get(id)!);
  assert.equal(keep.state, 'queued');
  assert.equal(keep.revision, 1);
  assert.equal(gone.state, 'cancelled');
  assert.equal(gone.revision, 2);
  const drained = await outbox.flush();
  assert.equal(calls.length, 1); // the child's cancel still wins after the restart
  assert.deepEqual((calls[0].payload as { body: string }).body, 'written by the child');
  assert.equal(drained.sent.length, 1);
  assert.equal(outbox.get(gone.id)!.state, 'cancelled');
  await outbox.close();
});
