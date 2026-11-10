// Restrict the committed receipts visible to the unchanged done-done gate to PR commits.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, head, tip = 'HEAD'] = process.argv.slice(2);
if (!base || !head) throw new Error('usage: node scripts/ci-done-done.ts <base> <pr-head> [merge-head]');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const merge = git('rev-parse', '--verify', `${tip}^{commit}`);
const commits = new Set(git('rev-list', `${base}..${head}`).split('\n').filter(Boolean));
const dir = '.done-done-receipts';
const names = git('ls-tree', '-r', '--name-only', merge, '--', dir).split('\n').filter(n => n.endsWith('.json'));
const selected = names.filter(name => {
  const contents = git('show', `${merge}:${name}`);
  try { return commits.has(JSON.parse(contents).head); } catch { return false; }
});
if (!selected.length) throw new Error('no receipt for a commit introduced by this pull request');
const scratch = mkdtempSync(join(tmpdir(), 'byokit-ci-gate-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index'), GIT_AUTHOR_NAME: 'CI gate', GIT_AUTHOR_EMAIL: 'ci-gate@example.invalid', GIT_COMMITTER_NAME: 'CI gate', GIT_COMMITTER_EMAIL: 'ci-gate@example.invalid' };
  const indexGit = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env }).trim();
  const pushed = git('show', '-s', '--format=%cI', merge);
  indexGit('read-tree', merge);
  for (const name of names) if (!selected.includes(name)) indexGit('update-index', '--force-remove', '--', name);
  const tree = indexGit('write-tree');
  const synthetic = execFileSync('git', ['commit-tree', tree, '-p', merge], { input: 'Scoped receipt gate\n', encoding: 'utf8', env }).trim();
  const result = spawnSync('done-done', ['gate', synthetic, '--pushed', pushed], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
