import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/ci-done-done.ts');
test('CI scopes the real receipt gate to PR commits', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-receipt-journey-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(cwd, 'product'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'product'), 'change'); git('commit', '-qam', 'change');
    const head = git('rev-parse', 'HEAD');
    mkdirSync(join(cwd, '.done-done-receipts'));
    const file = { path: 'capture.log', sha256: 'a'.repeat(64) };
    const receipt = { schema: 2, head, result: 'pass', at: new Date(Date.now() - 60000).toISOString(), claim: 'A user opens the application', files: [file], runs: [{ run_id: 'capture', command: 'open application', steps: { target: { version: '1' }, start: 'application closed', steps: ['open application'], result: 'application open' } }], judge: { route: 'test', model: 'test', independence: 'agent', verdicts: [{ ...file, verdict: 'pass' }] } };
    const oldHead = '1'.repeat(40);
    writeFileSync(join(cwd, '.done-done-receipts', `${oldHead}.json`), JSON.stringify({ ...receipt, head: oldHead }));
    writeFileSync(join(cwd, '.done-done-receipts', `${head}.json`), JSON.stringify(receipt));
    git('add', '.'); git('commit', '-qm', 'receipts');
    const scoped = run(base, head);
    assert.equal(scoped.status, 0, scoped.stderr + scoped.stdout);
    assert.match(scoped.stdout, /PASS/);
    const otherHead = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, '.done-done-receipts', `${otherHead}.json`), JSON.stringify({ ...receipt, head: otherHead, runs: [] }));
    git('add', '.'); git('commit', '-qm', 'another receipt');
    const anyValid = run(base, otherHead);
    assert.equal(anyValid.status, 0, anyValid.stderr + anyValid.stdout);
    receipt.runs = [];
    writeFileSync(join(cwd, '.done-done-receipts', `${head}.json`), JSON.stringify(receipt));
    git('add', '.'); git('commit', '-qm', 'missing capture');
    const missing = run(base, otherHead);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /no capture runs/);
    const unrelatedOnly = run(head, head);
    assert.notEqual(unrelatedOnly.status, 0);
    assert.match(unrelatedOnly.stderr, /no receipt for a commit/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
