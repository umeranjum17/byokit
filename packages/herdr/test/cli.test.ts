// H4 acceptance (docs/runtime-kits.md §11.3): runCli against a test-written shim — argv one per argument,
// NUL rejected, timeout reports timedOut, 8 MB buffer, explicit env passed verbatim, honest ENOENT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HerdrKit } from '../src/kit.ts';
import { runCli } from '../src/cli.ts';
import { makeShim, type Shim } from './shim.ts';

let shim: Shim;
before(async () => { shim = await makeShim(); });
after(async () => { await shim?.dispose(); });

const env = { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin', HERDR_SOCKET_PATH: '/tmp/herdr.sock' };

test('argv is passed one entry per argument, and the env verbatim, never inherited', async () => {
  const r = await runCli(shim.bin, { ...env, SHIM_OUT: shim.out },
    ['record', shim.out, 'hello world', 'say "hi"', "it's", '--cols', '80']);
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 7);
  assert.equal(r.stdout, 'to out\n');
  assert.equal(r.stderr, 'to err\n');
  const recorded = JSON.parse(await readFile(shim.out, 'utf8'));
  assert.deepEqual(recorded.argv, ['record', shim.out, 'hello world', 'say "hi"', "it's", '--cols', '80']);
  assert.deepEqual(recorded.env, { ...env, SHIM_OUT: shim.out },
    'the child sees exactly the env the kit passed, nothing from process.env');
});

test('validation: args must be a non-empty string array without NUL', () => {
  assert.throws(() => runCli(shim.bin, env, []), /non-empty/);
  assert.throws(() => runCli(shim.bin, env, ['ok', 3 as never]), /string/);
  assert.throws(() => runCli(shim.bin, env, ['ok', 'bad\0arg']), /NUL/);
  assert.throws(() => runCli('', env, ['x']), /bin/);
});

test('a timeout kills the child and reports timedOut with no exit code', async () => {
  const r = await runCli(shim.bin, env, ['hang'], 1_000);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
});

test('a sub-second timeout clamps up to the 1 s floor', async () => {
  const r = await runCli(shim.bin, env, ['hang'], 0);
  assert.equal(r.timedOut, true);
});

test('an 8 MB stdout flood rejects instead of buffering without bound', async () => {
  await assert.rejects(runCli(shim.bin, env, ['flood']), /8 MB buffer/);
});

test('a missing binary rejects with the missing/binary code', async () => {
  await assert.rejects(runCli(join(shim.dir, 'nope'), env, ['record']),
    (e: NodeJS.ErrnoException) => e.code === 'missing/binary' && /missing\/binary/.test(e.message));
});

test('kit.cli: per-call env overlays explicit kit env without inheriting the process or changing later calls', async () => {
  const kit = new HerdrKit({ mode: 'adopt', bin: shim.bin, socketPath: '/never-used', env: { ...env, SHIM_OUT: shim.out } });
  await kit.cli(['record'], { env: { CLAUDE_CONFIG_DIR: '/managed/account' } });
  const first = JSON.parse(await readFile(shim.out, 'utf8'));
  assert.equal(first.env.CLAUDE_CONFIG_DIR, '/managed/account');
  assert.equal(first.env.PATH, env.PATH);
  assert.equal(first.env.HERDR_SOCKET_PATH, env.HERDR_SOCKET_PATH);
  assert.equal(first.env.ANTHROPIC_API_KEY, undefined);
  await kit.cli(['record']);
  assert.equal(JSON.parse(await readFile(shim.out, 'utf8')).env.CLAUDE_CONFIG_DIR, undefined);
});
