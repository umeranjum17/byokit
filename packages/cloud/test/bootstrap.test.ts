import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOTSTRAP } from '../src/tailnet.ts';

// Runs the real bootstrap script under sh. PATH holds only stubs and the file tools the script needs,
// so no host tailscale, systemctl or curl can run; the root argument redirects /etc into a fixture.
function run(o: { tailscale: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-bootstrap-'));
  const bin = join(dir, 'bin');
  const root = join(dir, 'root');
  const tmp = join(dir, 'tmp');
  const log = join(dir, 'systemctl.log');
  const marker = join(dir, 'installed');
  for (const d of [bin, root, tmp]) mkdirSync(d);
  for (const tool of ['sh', 'mktemp', 'install', 'cmp', 'rm']) {
    const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(real, join(bin, tool));
  }
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('systemctl', `echo "$*" >> '${log}'`);
  stub('tailscaled', 'exit 0');
  if (o.tailscale) stub('tailscale', 'exit 0');
  else stub('curl', `out=\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then out=$2; fi; shift; done\necho "echo ran > '${marker}'" > "$out"`);
  const once = () => spawnSync('/bin/sh', ['-c', BOOTSTRAP, 'byokit', root], { env: { PATH: bin, TMPDIR: tmp }, encoding: 'utf8' });
  return { dir, bin, root, tmp, log, marker, once };
}
const systemctlCalls = (log: string) => readFileSync(log, 'utf8').trim().split('\n');
const dropIn = (root: string) => join(root, 'etc/systemd/system/tailscaled.service.d/byokit.conf');

test('bootstrap writes a userspace-networking drop-in with state under /etc, restarts only on change, and cleans its temp files', () => {
  const f = run({ tailscale: true });
  try {
    const first = f.once();
    assert.equal(first.status, 0, first.stderr);
    const exec = readFileSync(dropIn(f.root), 'utf8').split('\n').filter(l => l.startsWith('ExecStart=') && l !== 'ExecStart=').at(-1)!;
    const [binary, ...flags] = exec.slice('ExecStart='.length).split(' ');
    assert.equal(binary, join(f.bin, 'tailscaled'));
    assert.ok(flags.includes('--tun=userspace-networking'), 'no TUN device means userspace networking');
    assert.ok(flags.includes(`--state=${f.root}/etc/tailscale/tailscaled.state`));
    assert.equal(statSync(join(f.root, 'etc/tailscale')).mode & 0o777, 0o700);
    assert.deepEqual(systemctlCalls(f.log), ['daemon-reload', 'restart tailscaled', 'enable --now tailscaled']);
    assert.deepEqual(readdirSync(f.tmp), [], 'the temp directory is removed on exit');

    const second = f.once();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(systemctlCalls(f.log), ['daemon-reload', 'restart tailscaled', 'enable --now tailscaled', 'enable --now tailscaled'], 'an unchanged drop-in is not restarted');
    assert.deepEqual(readdirSync(f.tmp), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('bootstrap runs the official installer when Tailscale is absent and removes its temp installer', () => {
  const f = run({ tailscale: false });
  try {
    const result = f.once();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(f.marker), 'the downloaded installer was executed');
    assert.ok(existsSync(dropIn(f.root)));
    assert.deepEqual(readdirSync(f.tmp), [], 'the installer temp file is removed on exit');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
