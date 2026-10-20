import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkUserEnv } from './user-env-check.ts';

// A stub systemctl that prints the given environment lines.
function stub(dir: string, lines: string[], code = 0): string {
  const bin = join(dir, 'systemctl');
  writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "--user show-environment" ] || exit 9\ncat <<'EOF'\n${lines.join('\n')}\nEOF\nexit ${code}\n`);
  chmodSync(bin, 0o700);
  return bin;
}

test('a provider key in the systemd user environment fails, naming the variable and the unset command, never the value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-userenv-'));
  try {
    const bin = stub(dir, ['PATH=/usr/bin', 'OPENROUTER_API_KEY=sk-canary-value', 'GEMINI_API_KEY=canary-two', 'LANG=C']);
    const result = checkUserEnv(bin);
    assert.equal(result.ok, false);
    for (const name of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY']) assert.ok(result.message.includes(`systemctl --user unset-environment ${name}`), name);
    assert.ok(!result.message.includes('canary'));
    let exit = 0;
    try { execFileSync(process.execPath, [join(import.meta.dirname, 'user-env-check.ts'), '--systemctl', bin], { stdio: 'pipe' }); } catch (e) { exit = (e as { status: number }).status; }
    assert.equal(exit, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a clean user environment and a missing systemd both pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-userenv-'));
  try {
    assert.equal(checkUserEnv(stub(dir, ['PATH=/usr/bin', 'HOME=/home/you'])).ok, true);
    assert.equal(checkUserEnv(join(dir, 'missing')).ok, true);
    assert.equal(checkUserEnv(stub(dir, [], 1)).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
