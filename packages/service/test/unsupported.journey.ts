// Off Linux, every call is the typed unsupported result and nothing is written (docs/service-kit.md S5). CI job
// service-macos runs it on a disposable macos-latest runner until the launchd half lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { install, status, uninstall, ServiceError } from '@byokit/service';

const name = 'unsupported-check';
const { homedir } = userInfo();
const skip = (process.platform === 'linux' || process.env.GITHUB_ACTIONS !== 'true') && 'needs a disposable non-Linux GitHub-hosted runner';

test('install, status and uninstall are typed unsupported and write nothing', { skip }, async () => {
  const unsupported = (e: unknown): boolean => e instanceof ServiceError && e.code === 'unsupported';
  await assert.rejects(install({ name, bin: process.execPath }), unsupported);
  assert.deepEqual(await status({ name }), { phase: 'unsupported' });
  await assert.rejects(uninstall({ name }), unsupported);
  assert.equal(existsSync(join(homedir, '.config/systemd/user', `byokit-${name}.service`)), false);
  assert.equal(existsSync(join(homedir, 'Library/LaunchAgents', `com.byokit.${name}.plist`)), false);
});
