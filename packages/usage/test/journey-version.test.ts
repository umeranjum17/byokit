// What an app or command shows as its running version, read from real package folders the way a build reads them:
// a published install (no `changes/`), a workspace with pending change fragments, and a semver pre-release; then
// an app beside its host, matching and after the host was updated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pairLabel, versionLabel } from '@byokit/usage/version';
import { packageVersion } from '@byokit/usage/version/node';
import { scratchDir } from '../../test-support.ts';

function pkg(version: string, fragments: string[] = []): string {
  const dir = scratchDir('version');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@byokit/demo', version }));
  if (fragments.length) mkdirSync(join(dir, 'changes'));
  for (const f of fragments) writeFileSync(join(dir, 'changes', f), '- FEAT: something new.\n');
  return join(dir, 'package.json');
}

test('a build says whether it is the release, a pre-release or a dev build of unreleased changes', () => {
  const installed = packageVersion(pkg('0.2.13'));
  assert.deepEqual(installed, { name: '@byokit/demo', version: '0.2.13', channel: 'release' });
  assert.equal(versionLabel(installed), '0.2.13');

  const workspace = packageVersion(pathToFileURL(pkg('0.2.13', ['new-thing.md'])));
  assert.deepEqual(workspace, { name: '@byokit/demo', version: '0.2.13+dev', channel: 'dev' });
  assert.equal(versionLabel(workspace), '0.2.13+dev (dev build)');

  assert.equal(versionLabel(packageVersion(pkg('0.3.0-beta.1'))), '0.3.0-beta.1 (pre-release)');
  assert.equal(versionLabel(packageVersion(pkg('0.2.13', ['README.txt']))), '0.2.13', 'only .md fragments are changes');
  assert.throws(() => packageVersion(pkg('latest')), /"latest" is not a semver version/);
});

test('an app beside its host shows both, and a hint once they differ', () => {
  const app = packageVersion(pkg('0.2.13'));
  assert.deepEqual(pairLabel(app, undefined), { text: 'App 0.2.13 · Host not connected' });
  assert.deepEqual(pairLabel(app, packageVersion(pkg('0.2.13'))), { text: 'App 0.2.13 · Host 0.2.13' });
  assert.deepEqual(pairLabel(app, packageVersion(pkg('0.2.10'))), { text: 'App 0.2.13 · Host 0.2.10',
    mismatch: 'The app and the host run different versions: update the older one, then reload.' });
});
