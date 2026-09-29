// Both keyring dialects through fake CLIs: round trips, missing entries, and the D-C wire rule —
// the canary secret reaches the CLI on stdin only, never in argv or env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { keyringEnv, keyringStore } from '../src/index.ts';
import { writeFakeCli, type FakeTool } from './fake-cli.ts';

const CANARY = 'sk-canary-keyring-9f2c';
const code = (want: string) => (e: any) => e?.code === want;

function bench(tool: FakeTool, extraEnv?: Record<string, string>) {
  const dir = scratchDir(`keyring-${tool}`);
  const bin = writeFakeCli(dir, tool);
  const log = join(dir, 'invocations.jsonl');
  const state = join(dir, 'state.json');
  const canaryFile = join(dir, 'canary.txt');
  writeFileSync(canaryFile, CANARY);
  const env = { FAKE_TOOL: tool, FAKE_LOG: log, FAKE_STATE: state, FAKE_CANARY_FILE: canaryFile, ...extraEnv };
  const store = keyringStore({ bin, tool, env });
  const invocations = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { store, invocations };
}

for (const tool of ['secret-tool', 'security'] as const) {
  test(`${tool}: set/get/delete round-trips, missing is null/false`, async () => {
    const { store } = bench(tool);
    assert.equal(await store.get('openai'), null);
    assert.equal(await store.delete('openai'), false);
    await store.set('openai', CANARY);
    assert.equal(await store.get('openai'), CANARY);
    assert.equal(await store.delete('openai'), true);
    assert.equal(await store.get('openai'), null);
    assert.equal(await store.delete('openai'), false);
  });

  test(`${tool}: the canary is absent from every argv and env`, async () => {
    const { store, invocations } = bench(tool);
    await store.set('openai', CANARY);
    await store.get('openai');
    await store.delete('openai');
    const calls = invocations();
    assert.ok(calls.length >= 3, `expected calls, saw ${calls.length}`);
    for (const call of calls) {
      assert.equal(call.selfCheck, undefined, 'the fake CLI saw the canary in its argv or env');
      for (const arg of call.argv) assert.ok(!arg.includes(CANARY), `canary in argv: ${arg}`);
      for (const [key, value] of Object.entries(call.env)) {
        assert.ok(!(value as string).includes(CANARY), `canary in env ${key}`);
      }
    }
    assert.ok(calls.some((c) => c.stdinBytes === Buffer.byteLength(CANARY)), 'the secret arrived on stdin');
  });

  test(`${tool}: spawned env is exactly base plus host extras`, async () => {
    const extra = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/fake', FAKE_ONLY: 'yes' };
    const { store, invocations } = bench(tool, { DBUS_SESSION_BUS_ADDRESS: extra.DBUS_SESSION_BUS_ADDRESS });
    await store.set('openai', CANARY);
    const seen = invocations().map((c) => c.env);
    assert.ok(seen.length >= 1);
    for (const env of seen) {
      assert.deepEqual(
        Object.keys(env).sort(),
        ['FAKE_CANARY_FILE', 'FAKE_LOG', 'FAKE_STATE', 'FAKE_TOOL', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'PATH'].sort(),
      );
      assert.equal(env.PATH, '/usr/bin:/bin');
      assert.equal(env.LANG, 'C.UTF-8');
      assert.equal(env.DBUS_SESSION_BUS_ADDRESS, extra.DBUS_SESSION_BUS_ADDRESS);
    }
  });

  test(`${tool}: secrets with unicode and inner newlines round-trip`, async () => {
    const { store } = bench(tool);
    const secret = 'line one\nline two ✓\nno trailing';
    await store.set('multi', secret);
    assert.equal(await store.get('multi'), secret);
  });
}

test('keyringEnv builds from nothing, never from process.env', () => {
  assert.deepEqual(keyringEnv(), { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
  assert.deepEqual(keyringEnv({ A: '1' }), { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', A: '1' });
  assert.throws(() => keyringEnv({ A: 'has\0nul' }), code('invalid'));
});

test('a relative bin is invalid; a missing bin is unavailable', () => {
  const dir = scratchDir('keyring-bin');
  assert.throws(() => keyringStore({ bin: 'relative/fake', tool: 'secret-tool' }), code('invalid'));
  assert.throws(() => keyringStore({ bin: join(dir, 'nope'), tool: 'secret-tool' }), code('unavailable'));
  const notExecutable = join(dir, 'plain.txt');
  writeFileSync(notExecutable, 'x');
  assert.throws(() => keyringStore({ bin: notExecutable, tool: 'secret-tool' }), code('unavailable'));
});

test('keyring names and secrets are validated before any spawn', async () => {
  const dir = scratchDir('keyring-validate');
  const store = keyringStore({ bin: writeFakeCli(dir, 'secret-tool'), tool: 'secret-tool' });
  await assert.rejects(store.get(''), code('invalid'));
  await assert.rejects(store.get('has\0nul'), code('invalid'));
  await assert.rejects(store.set('ok', 'x'.repeat(1024 * 1024 + 1)), code('invalid'));
});
