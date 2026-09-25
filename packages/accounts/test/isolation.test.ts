// The isolation guarantee, shown three ways around one real run (isolated-run.ts): a decoy HOME holding someone's Pi,
// Codex and Claude sign-ins plus the environment a shell inside their Pi hands down; an fs tracer; and Node's
// permission model, so the operating system itself refuses any read outside the kit and the app's own folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { join, resolve } from 'node:path';
import { decoy, traceFs } from '../src/testing/index.ts';

test("a sign-in, a stored sign-in and its status never touch anyone else's AI setup", () => {
  const d = decoy(scratchDir('decoy'));
  const app = join(d.root, 'app');
  mkdirSync(app);
  const repo = resolve(import.meta.dirname, '..', '..', '..');
  const allow = ['--permission', `--allow-fs-read=${repo}`, `--allow-fs-read=${app}`, `--allow-fs-write=${app}`, `--allow-fs-write=${d.env.TRACE_LOG}`];
  const node = (...args: string[]) => spawnSync(process.execPath, [...allow, ...args], { env: { PATH: process.env.PATH, ...d.env, APP_DIR: app }, encoding: 'utf8', timeout: 20_000 });
  // Control: under these flags, reading the decoy is refused outright.
  const control = node('--input-type=module', '-e', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(d.home, '.pi', 'agent', 'auth.json'))});`);
  assert.match(control.stderr, /ERR_ACCESS_DENIED/);
  const r = node('--import', traceFs, join(import.meta.dirname, 'isolated-run.ts'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.deepEqual([out.code, out.url], ['MOCK-12345', 'https://auth.openai.com/codex/device'], 'the real ChatGPT sign-in reached its code');
  assert.deepEqual([out.cancelled, out.ready, out.openrouter, out.other], [false, true, false, false]);
  assert.equal(out.words, 'ChatGPT is connected.');
  assert.deepEqual(out.env, ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY']);
  assert.ok(out.asked.every((u: string) => u.startsWith('auth.openai.com/api/accounts/deviceauth/')), out.asked.join(', '));

  assert.equal(d.touched(), '', 'the tracer saw a touch');
  assert.deepEqual(d.changed(), [], 'byte for byte, and not even rewritten');
  assert.deepEqual(d.ran(), []);
  assert.deepEqual(d.leaks(app), [], 'a key or sign-in from the decoy reached the app\'s folder');
});
