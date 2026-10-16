// A refused linger on a real systemd --user host (docs/service-kit.md 5). CI job service-linux first denies the
// runner's own linger through a polkit rule (setup only, with sudo), runs the 'refused' test, lifts the rule and
// re-enables linger, then runs the 'leftover' test. Never under scripts/test.sh, never on a person's computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { install, uninstall, ServiceError } from '@byokit/service';

const runner = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true';
const skip = !runner && 'needs a disposable GitHub-hosted Linux runner';
const name = 'linger-check';
const { username, homedir } = userInfo();
const unitFile = join(homedir, '.config/systemd/user', `byokit-${name}.service`);

test('a refused linger rejects linger with the line to run and never escalates', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-service-'));
  const bin = join(dir, 'host.sh');
  writeFileSync(bin, '#!/bin/sh\nexec sleep 300\n');
  chmodSync(bin, 0o755);
  try {
    await assert.rejects(install({ name, bin }), (e) =>
      e instanceof ServiceError && e.code === 'linger' && e.detail.command === `sudo loginctl enable-linger ${username}`);
    assert.equal(existsSync(`/var/lib/systemd/linger/${username}`), false, 'linger still off: nothing escalated');
    assert.ok(existsSync(unitFile), 'the unit file is written before enable-linger (spec 4.1)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the leftover unit uninstalls once linger is back', { skip }, async () => {
  await uninstall({ name });
  assert.equal(existsSync(unitFile), false);
});
