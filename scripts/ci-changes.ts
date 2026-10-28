// Which slow CI areas a pull request can affect, as GitHub step outputs (`area=true|false`).
// Usage: node scripts/ci-changes.ts <base-sha>   (a pull request's base, or a push's previous tip; no usable base: every area runs)
// An area runs when a changed file sits under one of its paths or under a shared build input; Markdown never counts.
// Each area lists its job's packages with their @byokit dependencies, so a change in a dependency still runs the job.
// `code` is false only for a docs-only or evidence-only change (Markdown, docs/, LICENSE files, proof/ and done-done receipts):
// the every-PR jobs then skip their tests.
import { execFileSync } from 'node:child_process';

const kits = (...names: string[]): string[] => names.map((n) => `packages/${n}/`);
const AREAS: Record<string, string[]> = {
  openclaw: kits('openclaw', 'pair', 'relay', 'discover', 'seal', 'secrets', 'ui', 'accounts', 'usage'),
  write: kits('write'),
  record: kits('record'),
  seal: kits('seal'),
  secrets: [...kits('secrets', 'seal'), 'scripts/test-keyring.sh'],
  // The frozen Kotlin mirror bundles fixtures/ and the accounts catalogue and words.
  android: ['android/', 'examples/dictation-android/', 'examples/realtime-android/', 'fixtures/', ...kits('dictation', 'audio', 'realtime', 'accounts')],
  expo: [
    'examples/expo/', 'scripts/share-expo-smoke.ts', 'scripts/statusbar-expo-smoke.ts',
    ...kits('accounts', 'decide', 'pair', 'bubble', 'seal', 'statusbar', 'ui', 'push', 'usage', 'share', 'infer', 'secrets', 'discover'),
  ],
};
const SHARED = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', '.github/workflows/ci.yml', 'scripts/fix-words-dts.cjs', 'scripts/test.sh', 'scripts/test-egress-guard.cjs', 'packages/test-support.ts'];

const NOT_CODE = /^(docs|proof|\.done-done-receipts)\/|(^|\/)LICENSE[^/]*$/;

// A new branch's push has an all-zero previous tip, and a force-pushed one may be gone: no usable base runs everything.
const base = /^0*$/.test(process.argv[2] ?? '') ? undefined : process.argv[2];
let changed: string[] | null = null;
if (base) {
  try {
    changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).split('\n').filter((f) => f && !f.endsWith('.md'));
  } catch {
    console.error(`ci-changes: cannot diff ${base}...HEAD, running every area`);
  }
}
console.log(`code=${changed === null || changed.some((f) => !NOT_CODE.test(f))}`);
const shared = changed === null || changed.some((f) => SHARED.includes(f));
for (const [area, paths] of Object.entries(AREAS)) {
  const run = shared || changed!.some((f) => paths.some((p) => f.startsWith(p)));
  console.log(`${area}=${run}`);
}
