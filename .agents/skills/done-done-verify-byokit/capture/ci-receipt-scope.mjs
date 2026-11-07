// Drives scripts/ci-changes.ts on real git diffs and shows which changes the done-done job asks a receipt for.
// A dependency-manifest or workflow-only diff gets receipt=false; product code, tests, scripts and packages/ manifests keep receipt=true.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
if (!evidence) throw new Error('DONE_DONE_EVIDENCE_ROOT is not set; run this from a done-done run');
const script = join(process.cwd(), 'scripts/ci-changes.ts');
const dir = mkdtempSync(join(tmpdir(), 'ci-receipt-scope-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const touch = (f) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); f.endsWith('.json') ? writeFileSync(join(dir, f), `{"touched":"${f}"}\n`) : appendFileSync(join(dir, f), `${f}\n`); };

const cases = [
  ['dependency bump: package.json, package-lock.json, example manifest', ['package.json', 'package-lock.json', 'examples/expo/package.json'], false],
  ['workflow bump: .github/workflows/ci.yml, .github/dependabot.yml', ['.github/workflows/ci.yml', '.github/dependabot.yml'], false],
  ['product source: packages/pair/src/index.ts', ['packages/pair/src/index.ts'], true],
  ['kit manifest: packages/pair/package.json', ['packages/pair/package.json'], true],
  ['script: scripts/test.sh', ['scripts/test.sh'], true],
  ['dependency bump plus a test file', ['package.json', 'packages/pair/test/x.test.ts'], true],
  ['android: android/build.gradle', ['android/build.gradle'], true],
  ['tsconfig.base.json', ['tsconfig.base.json'], true],
  ['docs only: docs/a.md', ['docs/a.md'], false],
];
const log = [];
let failed = 0;
try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'proof');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts/ci-changes.ts'));
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  for (const [name, files, want] of cases) {
    git('checkout', '-q', '-B', 'pr', base);
    files.forEach(touch);
    git('add', '-A'); git('commit', '-qm', 'change');
    const out = execFileSync('node', ['scripts/ci-changes.ts', base], { cwd: dir, encoding: 'utf8' });
    const got = /^receipt=(true|false)$/m.exec(out)?.[1];
    const ok = got === String(want);
    if (!ok) failed++;
    log.push(`${ok ? 'ok  ' : 'FAIL'} receipt=${got} (want ${want}) ${name}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
log.push(failed ? `${failed} case(s) wrong` : 'every case matched: dependency-only and workflow-only diffs need no receipt; all product changes still do');
writeFileSync(join(evidence, 'ci-receipt-scope.log'), `${log.join('\n')}\n`);
console.log(log.join('\n'));
if (failed) process.exit(1);
writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
  target: { version: 'scripts/ci-changes.ts at the pull request head' },
  start: 'an empty git repository holding the committed scripts/ci-changes.ts and one base commit',
  steps: cases.map(([name]) => `Commit a change (${name}) and run node scripts/ci-changes.ts against the base`),
  result: log[log.length - 1],
}, null, 2)}\n`);
