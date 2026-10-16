// The docs/service-kit.md section 7 journey on a real systemd --user manager. It installs a real unit, so it runs
// only on a disposable GitHub-hosted Linux runner (CI job service-linux), never under scripts/test.sh (whose
// throwaway HOME hides the user manager) and never on a person's computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { install, status, uninstall } from '../src/index.ts';

const runner = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true';
const name = 'journey-echo';
const unit = `byokit-${name}.service`;
const { uid, username, homedir } = userInfo();
const userEnv = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${uid}` };

const isActive = (): string =>
  spawnSync('systemctl', ['--user', 'is-active', unit], { env: userEnv, encoding: 'utf8' }).stdout.trim();

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

/** Send a line to the echo on loopback and read it back, retrying while the host starts. */
async function echo(port: number, line: string): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        const c = connect(port, '127.0.0.1', () => c.end(line));
        let got = '';
        c.setEncoding('utf8').on('data', (s: string) => { got += s; }).on('end', () => resolve(got)).on('error', reject);
      });
    } catch (e) {
      if (i === 50) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

test('install runs a loopback echo as a per-user unit, status reads it, uninstall removes it', { skip: !runner && 'needs a disposable GitHub-hosted Linux runner' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-service-'));
  const bin = join(dir, 'echo.mjs');
  writeFileSync(bin, `#!${process.execPath}\nimport { createServer } from 'node:net';\n` +
    `createServer((c) => c.pipe(c)).listen(Number(process.env.ECHO_PORT), '127.0.0.1');\n`);
  chmodSync(bin, 0o755);
  const port = await freePort();
  try {
    assert.deepEqual(await status({ name }), { phase: 'not-installed' });

    await install({ name, bin, env: { ECHO_PORT: String(port) } });
    assert.ok(existsSync(join(homedir, '.config/systemd/user', unit)), 'unit file under the login home');
    assert.deepEqual(await status({ name }), { phase: 'running' });
    assert.equal(isActive(), 'active');
    assert.equal(execFileSync('loginctl', ['show-user', username, '-p', 'Linger'], { encoding: 'utf8' }).trim(), 'Linger=yes');
    assert.equal(await echo(port, 'hello from Umer\n'), 'hello from Umer\n');

    // Re-install is a rewrite and restart, not a duplicate.
    await install({ name, bin, env: { ECHO_PORT: String(port) } });
    assert.equal(isActive(), 'active');
    assert.equal(await echo(port, 'again\n'), 'again\n');

    await uninstall({ name });
    assert.equal(existsSync(join(homedir, '.config/systemd/user', unit)), false, 'unit file removed');
    assert.equal(isActive(), 'inactive');
    assert.deepEqual(await status({ name }), { phase: 'not-installed' });
    await uninstall({ name }); // idempotent
  } finally {
    await uninstall({ name }).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
