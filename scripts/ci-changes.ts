// Which slow CI areas a pull request can affect, as GitHub step outputs (`area=true|false`).
// Usage: node scripts/ci-changes.ts <base-sha>   (no base: every area runs, as on a push to main)
// An area runs when a changed file sits under one of its paths or under a shared build input; Markdown never counts.
// Each area lists its job's packages with their @byokit dependencies, so a change in a dependency still runs the job.
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
    ...kits('accounts', 'decide', 'pair', 'bubble', 'seal', 'statusbar', 'ui', 'push', 'usage', 'share', 'infer', 'secrets'),
  ],
};
const SHARED = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', '.github/workflows/ci.yml', 'scripts/fix-words-dts.cjs', 'scripts/test.sh', 'scripts/test-egress-guard.cjs', 'packages/test-support.ts'];

const base = process.argv[2];
const changed = base
  ? execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' }).split('\n').filter((f) => f && !f.endsWith('.md'))
  : null;
const shared = changed === null || changed.some((f) => SHARED.includes(f));
for (const [area, paths] of Object.entries(AREAS)) {
  const run = shared || changed!.some((f) => paths.some((p) => f.startsWith(p)));
  console.log(`${area}=${run}`);
}
