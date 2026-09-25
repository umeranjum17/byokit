// The harness must catch what it exists to catch: a touch, a changed byte, a leaked canary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { decoy, traceFs, CANARY } from '../src/testing/index.ts';

const run = (d: ReturnType<typeof decoy>, code: string) =>
  spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', code], { env: { ...process.env, ...d.env }, encoding: 'utf8' });

test('a clean run leaves the decoy untouched', () => {
  const d = decoy(scratchDir('decoy'));
  const r = run(d, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(d.root, 'app.txt'))}, 'mine');`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(d.touched(), '');
  assert.deepEqual(d.changed(), []);
  assert.deepEqual(d.leaks(d.root).filter((f) => !d.roots.some((r) => f.startsWith(r))), []);
});

test('reading, rewriting or copying from the decoy is caught', () => {
  const d = decoy(scratchDir('decoy'));
  const auth = join(d.home, '.pi', 'agent', 'auth.json');
  const app = join(d.root, 'app');
  mkdirSync(app);
  const r = run(d, `import { readFileSync, writeFileSync } from 'node:fs'; const t = readFileSync(${JSON.stringify(auth)}); writeFileSync(${JSON.stringify(auth)}, t); writeFileSync(${JSON.stringify(join(app, 'copy.json'))}, t);`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(d.touched(), /\.pi\/agent\/auth\.json/);
  assert.deepEqual(d.changed(), [auth], 'rewritten with the same bytes still counts');
  assert.equal(d.leaks(app).length, 1);
  writeFileSync(join(d.marks, 'pi'), 'ran');
  assert.deepEqual(d.ran(), ['pi']);
  assert.ok(d.env.OPENAI_API_KEY.includes(CANARY));
});
