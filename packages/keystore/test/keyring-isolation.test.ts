// The isolation guarantee: beside a throwaway HOME sits a decoy HOME holding someone's Pi,
// Codex and Claude sign-ins. A child under `node --permission` stores a canary through the fake
// keyring CLIs and the passphrase file; the decoy must come out byte for byte as it went in, and
// the canary must be absent from every fake argv and env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scratchDir } from '../../test-support.ts';

const DECOYS: Record<string, string> = {
  '.pi/agent/auth.json': JSON.stringify({ openai: 'decoy-pi-canary-aaa' }),
  '.codex/auth.json': JSON.stringify({ token: 'decoy-codex-canary-bbb' }),
  '.claude.json': JSON.stringify({ oauth: 'decoy-claude-canary-ccc' }),
};

function snapshot(home: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full, readFileSync(full));
    }
  };
  walk(home);
  return files;
}

test('a keystore run never touches anyone else\'s AI setup', () => {
  const decoyHome = scratchDir('decoy-home');
  for (const [rel, text] of Object.entries(DECOYS)) {
    const full = join(decoyHome, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  const before = snapshot(decoyHome);
  const repo = resolve(import.meta.dirname, '..', '..', '..');
  const runFile = join(import.meta.dirname, 'isolated-run.ts');

  // Control: under these flags, reading the decoy is refused outright.
  const control = spawnSync(
    process.execPath,
    ['--permission', `--allow-fs-read=${repo}`, '--input-type=module', '-e',
      `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(decoyHome, '.pi', 'agent', 'auth.json'))});`],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.match(control.stderr, /ERR_ACCESS_DENIED/);

  for (const tool of ['secret-tool', 'security']) {
    const work = scratchDir(`isolated-run-${tool}`);
    const allow = [
      '--permission',
      `--allow-fs-read=${repo}`,
      `--allow-fs-read=${work}`,
      `--allow-fs-write=${work}`,
      '--allow-child-process',
    ];
    const r = spawnSync(process.execPath, [...allow, runFile, work, tool], {
      env: { PATH: '/usr/bin:/bin', HOME: decoyHome },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 0, `tool ${tool}: exit ${r.status}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    assert.equal(out.ok, true, `tool ${tool}: ${JSON.stringify(out)}`);

    // The fakes logged every call: the canary reached them on stdin only.
    const calls = readFileSync(join(work, 'invocations.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(calls.length >= 3, `tool ${tool}: expected calls, saw ${calls.length}`);
    for (const call of calls) {
      assert.equal(call.selfCheck, undefined, `tool ${tool}: the fake saw the canary in argv or env`);
      for (const arg of call.argv) assert.ok(!arg.includes('sk-canary-isolation-1c5d'), `canary in argv: ${arg}`);
      for (const [key, value] of Object.entries(call.env)) {
        assert.ok(!(value as string).includes('sk-canary-isolation-1c5d'), `canary in env ${key}`);
      }
    }
  }

  const after = snapshot(decoyHome);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'the decoy gained or lost files');
  for (const [path, bytes] of before) assert.deepEqual(after.get(path), bytes, `decoy file changed: ${path}`);
});
