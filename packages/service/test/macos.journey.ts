// The docs/service-kit.md section 7 journey on a real launchd: a per-user LaunchAgent in the runner's gui domain,
// plus the one contract suite (./testing) against the same launchd. It installs a real agent, so it runs only on a disposable GitHub-hosted macOS runner (CI job service-macos), never
// under scripts/test.sh and never on a person's computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { install, status, uninstall } from '../src/index.ts';
import { serviceContract, type ServiceBench } from '../src/testing.ts';

const runner = process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true';
const skip = !runner && 'needs a disposable GitHub-hosted macOS runner';
const name = 'journey-echo';
const { uid, homedir } = userInfo();
const plist = join(homedir, 'Library/LaunchAgents', `com.byokit.${name}.plist`);

const print = (): { code: number | null; out: string } => {
  const r = spawnSync('launchctl', ['print', `gui/${uid}/com.byokit.${name}`], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
};

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

test('install runs a loopback echo as a LaunchAgent, status reads it, uninstall removes it', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-service-'));
  const bin = join(dir, 'echo.mjs');
  writeFileSync(bin, `#!${process.execPath}\nimport { createServer } from 'node:net';\n` +
    `createServer((c) => c.pipe(c)).listen(Number(process.env.ECHO_PORT), '127.0.0.1');\n`);
  chmodSync(bin, 0o755);
  const port = await freePort();
  try {
    assert.deepEqual(await status({ name }), { phase: 'not-installed' });

    await install({ name, bin, env: { ECHO_PORT: String(port) } });
    assert.ok(existsSync(plist), 'plist under the login home');
    assert.equal(await echo(port, 'hello from Umer\n'), 'hello from Umer\n');
    assert.deepEqual(await status({ name }), { phase: 'running' });
    const p = print();
    assert.equal(p.code, 0);
    assert.match(p.out, /^\s*state = running$/m);
    console.log(p.out.split('\n').filter((l) => /^\s*(state|path|program|pid) = /.test(l)).join('\n'));

    // Re-install is a reload on the new bytes, not a duplicate.
    await install({ name, bin, env: { ECHO_PORT: String(port) } });
    assert.equal(await echo(port, 'again\n'), 'again\n');
    assert.deepEqual(await status({ name }), { phase: 'running' });

    await uninstall({ name });
    assert.equal(existsSync(plist), false, 'plist removed');
    assert.notEqual(print().code, 0, 'launchctl print fails once booted out');
    assert.deepEqual(await status({ name }), { phase: 'not-installed' });
    await uninstall({ name }); // idempotent
  } finally {
    await uninstall({ name }).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same contract suite (packages/service/src/testing.ts) against the real launchd; its fake-only cases skip.
const realBench = (): ServiceBench => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-service-contract-'));
  const bin = join(dir, 'host.sh');
  writeFileSync(bin, '#!/bin/sh\nexec sleep 300\n');
  chmodSync(bin, 0o755);
  return {
    bin,
    service: { install, status, uninstall },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
};

serviceContract('launchd', realBench, (testName, fn) =>
  test(testName, { skip }, async (t) => {
    await fn({ skip: (message) => t.skip(message) });
  }));
