import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('public RN and browser keys entries resolve live vendor ids and answer without a consumer catalogue', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  for (const condition of ['react-native', 'browser']) {
    const run = spawnSync(process.execPath, [`--conditions=${condition}`, '--require', './scripts/test-egress-guard.cjs',
      '.agents/skills/done-done-verify-byokit/capture/accounts-rn-models.mjs'], { cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, DONE_DONE_EVIDENCE_ROOT: '' } });
    assert.equal(run.status, 0, `${condition}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /native-answer: Hello Umer/);
    assert.match(run.stdout, /billing=api, never relabelled free; ambient-reads=0/);
  }
});
