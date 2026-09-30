// Secret sources never come from the environment. Only automatic platform placement and
// non-interactive keyring helpers may read the explicitly enumerated OS session settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { fileStore, keyringStore, overrideStore } from '../src/index.ts';
import { writeFakeCli } from './fake-cli.ts';
import { writeFileSync } from 'node:fs';

const CANARY = 'sk-canary-env-7a3b';

test('src/ reads only OS placement/session settings in the automatic sealing helpers', () => {
  const allowed: Record<string, string[]> = {
    'host-key-file.ts': ['XDG_STATE_HOME', 'LOCALAPPDATA', 'SystemRoot'],
    'bounded-keyring.ts': ['HOME', 'USERPROFILE', 'SystemRoot', 'DBUS_SESSION_BUS_ADDRESS', 'NODE_OPTIONS'],
    'keyring-worker.ts': ['DBUS_SESSION_BUS_ADDRESS'],
  };
  const src = join(import.meta.dirname, '..', 'src');
  for (const file of readdirSync(src)) {
    if (!file.endsWith('.ts')) continue;
    const lines = readFileSync(join(src, file), 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      // Comments may document the rule; code must not read the env.
      const code = line.split('//')[0].replace(/\/\*.*?\*\//g, '');
      const matches = [...code.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g)];
      for (const match of matches) assert.ok(match[1] && allowed[file]?.includes(match[1]), `${file}:${i + 1} reads an unapproved environment setting`);
    }
  }
});

test('a poisoned process.env changes nothing', async () => {
  const dir = scratchDir('env-proof');
  const saved = { ...process.env };
  const MARKER = 'env-poison-marker-zz9';
  try {
    process.env.PATH = `/nonexistent-${MARKER}`;
    process.env.HOME = join(dir, 'decoy-home');
    process.env.VICTIM_NAME = CANARY;
    process.env.OPENAI_API_KEY = `${MARKER}-should-never-be-read`;
    process.env.DBUS_SESSION_BUS_ADDRESS = `${MARKER}-bus`;

    // The override backend consults only the map the host passes, never the environment.
    const over = overrideStore({});
    assert.equal(await over.get('VICTIM_NAME'), null);
    assert.equal(await over.get('OPENAI_API_KEY'), null);

    // The file backend works under the poisoned env (absolute paths, no env reads).
    const file = fileStore({ path: join(dir, 'keys.json'), passphrase: 'pass' });
    await file.set('openai', CANARY);
    assert.equal(await file.get('openai'), CANARY);

    // The keyring spawn inherits nothing: the fake sees no poison marker.
    const bin = writeFakeCli(dir, 'secret-tool');
    const log = join(dir, 'invocations.jsonl');
    const canaryFile = join(dir, 'canary.txt');
    writeFileSync(canaryFile, CANARY);
    const ring = keyringStore({
      bin,
      tool: 'secret-tool',
      env: { FAKE_TOOL: 'secret-tool', FAKE_LOG: log, FAKE_STATE: join(dir, 'state.json'), FAKE_CANARY_FILE: canaryFile },
    });
    await ring.set('openai', CANARY);
    assert.equal(await ring.get('openai'), CANARY);
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(calls.length >= 2);
    for (const call of calls) {
      assert.ok(!('VICTIM_NAME' in call.env), 'process.env leaked into the spawn');
      assert.ok(!('OPENAI_API_KEY' in call.env), 'process.env leaked into the spawn');
      assert.ok(!Object.values(call.env).some((v) => String(v).includes(MARKER)), 'poison value in spawn env');
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});
