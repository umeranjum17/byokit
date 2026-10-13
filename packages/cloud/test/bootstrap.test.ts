import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOTSTRAP } from '../src/tailnet.ts';

// Runs the real bootstrap script under sh. PATH holds only stubs and the file tools the script needs,
// so no host tailscale, systemctl or curl can run; the root argument redirects /etc into a fixture.
function run(o: { tailscale: boolean; arch?: 'x86_64' | 'aarch64'; badChecksum?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-bootstrap-'));
  const bin = join(dir, 'bin');
  const root = join(dir, 'root');
  const tmp = join(dir, 'tmp');
  const log = join(dir, 'systemctl.log');
  const marker = join(dir, 'extracted');
  const download = join(dir, 'download');
  const verified = join(dir, 'verified');
  for (const d of [bin, root, tmp]) mkdirSync(d);
  for (const tool of ['sh', 'mktemp', 'install', 'cmp', 'rm', 'mkdir', ...(o.badChecksum ? ['sha256sum'] : [])]) {
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
  else {
    stub('uname', `echo '${o.arch ?? 'x86_64'}'`);
    stub('curl', `echo "$*" > '${download}'\nout=\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then out=$2; fi; shift; done\necho 'not a Tailscale archive' > "$out"`);
    // Success fixtures do not bundle released binaries; the mismatch case uses the real sha256sum.
    if (!o.badChecksum) stub('sha256sum', `[ "$1" = -c ] && [ "$2" = - ] || exit 1\nread -r sum file\nprintf '%s  %s\\n' "$sum" "$file" > '${verified}'`);
    stub('tar', `echo ran > '${marker}'\nwhile [ "$1" != -C ]; do shift; done\nout=$2; archive=\${3%/*}\nmkdir -p "$out/$archive"\nprintf '#!/bin/sh\\nexit 0\\n' > "$out/$archive/tailscale"\nprintf '#!/bin/sh\\nexit 0\\n' > "$out/$archive/tailscaled"`);
  }
  const once = () => spawnSync('/bin/sh', ['-c', BOOTSTRAP, 'byokit', root], { env: { PATH: bin, TMPDIR: tmp }, encoding: 'utf8' });
  return { dir, bin, root, tmp, log, marker, download, verified, once };
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

test('bootstrap verifies the pinned static archive and installs both binaries and a unit on amd64 and arm64', () => {
  for (const [arch, releaseArch, sha] of [
    ['x86_64', 'amd64', '108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528'],
    ['aarch64', 'arm64', 'f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806'],
  ] as const) {
    const f = run({ tailscale: false, arch });
    try {
      const result = f.once();
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readFileSync(f.download, 'utf8').includes(`https://pkgs.tailscale.com/stable/tailscale_1.104.1_${releaseArch}.tgz`));
      assert.ok(readFileSync(f.verified, 'utf8').startsWith(`${sha}  `));
      assert.ok(existsSync(f.marker), 'the verified archive was extracted');
      for (const path of ['usr/bin/tailscale', 'usr/sbin/tailscaled'])
        assert.equal(statSync(join(f.root, path)).mode & 0o777, 0o755);
      assert.ok(readFileSync(join(f.root, 'etc/systemd/system/tailscaled.service'), 'utf8').includes(`ExecStart=${f.root}/usr/sbin/tailscaled`));
      assert.ok(existsSync(dropIn(f.root)));
      assert.deepEqual(readdirSync(f.tmp), [], 'the archive temp file is removed on exit');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('bootstrap refuses a bad checksum before extraction, installation or service changes', () => {
  const f = run({ tailscale: false, badChecksum: true });
  try {
    const result = f.once();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum did NOT match/);
    assert.ok(!existsSync(f.marker), 'tar never ran');
    assert.deepEqual(readdirSync(f.root), [], 'no binaries, unit or state directory installed');
    assert.ok(!existsSync(f.log), 'systemctl never ran');
    assert.deepEqual(readdirSync(f.tmp), [], 'failed download scratch is removed');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
