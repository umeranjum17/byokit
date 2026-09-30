// BK-P2 (docs/capability-kits.md 9.2): the contract against the real pinned engine, in process (`new Compose()`) and
// through its own bin; the committed schema is the engine's own; the `compose` CLI answers over the real pin.
// CI job `write-engine` only (`npm run test:write-engine`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { main } from '../../src/cli.ts';
import { Compose } from '../../src/compose.ts';
import { ENGINE_VERSION } from '../../src/constants.ts';
import { binEngine } from '../../src/engine.ts';
import { composeContract } from '../../src/testing/index.ts';
import { engineBin } from './engine.ts';

composeContract(async () => ({ compose: new Compose() }), {
  test: (name, fn) => test(`in process: ${name}`, fn),
});

composeContract(async () => ({ compose: new Compose({ engine: binEngine({ bin: engineBin }) }) }), {
  test: (name, fn) => test(`as a bin: ${name}`, fn),
});

test('the committed schema equals `ownvoice-engine schema` output', () => {
  const committed = JSON.parse(readFileSync(new URL('../../schema/engine-protocol-1.json', import.meta.url), 'utf8'));
  const live = JSON.parse(execFileSync(process.execPath, [engineBin, 'schema'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }));
  assert.deepEqual(live, committed);
});

test('the engine is the pinned version', async () => {
  assert.deepEqual(await new Compose().hello(), { protocol: 1, version: ENGINE_VERSION });
});

test('`compose platforms` through main() over the real pin: exit 0 and six rows', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(['platforms'], { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s), readFile: () => '' });
  assert.deepEqual([code, stderr], [0, []]);
  const lines = stdout.join('').trimEnd().split('\n');
  assert.equal(lines[0], 'platforms[6]{id,label,kind,limit}:');
  assert.deepEqual(lines.slice(1).map((row) => row.trim().split(',')[0]), ['x', 'linkedin', 'reddit', 'slack', 'whatsapp', 'gmail']);
});
