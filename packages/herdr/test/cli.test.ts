// H4 acceptance (docs/runtime-kits.md §11.3): runCli against a test-written shim — argv one per argument,
// explicit env passed verbatim, never inherited from the process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  // macOS injects __CF_USER_TEXT_ENCODING into every spawned process outside the kit's
  // control, so exact-env assertions ignore that one key on all platforms.
  const { __CF_USER_TEXT_ENCODING: _injected, ...seen } = recorded.env;
  assert.deepEqual(seen, { ...env, SHIM_OUT: shim.out },
    'the child sees exactly the env the kit passed, nothing from process.env');
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
