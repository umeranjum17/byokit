// byk-pin-watch dry run: the drift script against recorded fixtures, fully
// offline (npm test blocks outbound network via scripts/test-egress-guard.cjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(repoDir, 'scripts', 'pin-watch.mjs');
const fixtures = join(repoDir, 'scripts', 'fixtures', 'pin-watch');

function run(format: string): string {
  return execFileSync('node', [script, '--fixtures', fixtures, '--format', format], {
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('fixture dry run prints the 2026.8.1 -> 2026.9.6 method diff (+92/-3)', () => {
  const summary = run('summary');
  assert.match(summary, /2026\.8\.1 -> latest 2026\.9\.6: methods \+92\/-3 \(393 -> 482\)/);
  assert.match(summary, /sessions\.compaction\.(branch|list|restore)/);
  assert.match(summary, /extended-stable 2026\.8\.33: methods \+1\/-0 \(393 -> 394\)/);
  assert.match(summary, /herdr pin 0\.9\.1 \(protocol 22\): up to date/);
  assert.match(summary, /drift: yes/);
});

test('fixture dry run as JSON carries the added/removed lists', () => {
  const report = JSON.parse(run('json'));
  assert.equal(report.openclaw.pin, '2026.8.1');
  assert.equal(report.openclaw.latest, '2026.9.6');
  assert.equal(report.openclaw.toLatest.methods.added.length, 92);
  assert.deepEqual(report.openclaw.toLatest.methods.removed, [
    'sessions.compaction.branch',
    'sessions.compaction.list',
    'sessions.compaction.restore',
  ]);
  assert.equal(report.openclaw.toLatest.events.added.length, 9);
  assert.deepEqual(report.openclaw.toLatest.events.removed, []);
  assert.equal(report.herdr.drift, false);
  assert.equal(report.drift, true);
});

test('fixture dry run renders an issue body with the diff', () => {
  const body = run('issue-body');
  assert.match(body, /# Upstream pin drift/);
  assert.match(body, /\+92\/-3/);
  assert.match(body, /sessions\.compaction\.list/);
});
