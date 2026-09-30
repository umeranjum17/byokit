// The SSH VM adapter against the fake `ssh`/`ssh-keyscan` bench
// (docs/cloud-kit.md M2 acceptance): exact argv and `ssh_config` bytes, the
// fixed env, option rules, host-key mapping, caps, timeouts, sudo, first
// connect, and `sshHostKey`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { sshVm, sshHostKey } from '../src/ssh.ts';
import type { SshVmOptions } from '../src/ssh.ts';
import { setupFakeSsh, fakeKeyFingerprint, type FakeSshBench } from '../src/testing/fake-ssh.ts';
import type { MachineRef } from '../src/types.ts';
import { MachineError } from '../src/errors.ts';

const CAP = 8 * 1024 * 1024;

function benchRoot(name: string): { bench: FakeSshBench; root: string } {
  const root = scratchDir(name);
  return { bench: setupFakeSsh(join(root, 'fake')), root };
}

async function confirmed(name: string, patch?: Partial<SshVmOptions>): Promise<{
  bench: FakeSshBench; root: string; stateDir: string; keyPath: string;
  provider: ReturnType<typeof sshVm>; ref: MachineRef; fingerprint: string;
}> {
  const { bench, root } = benchRoot(name);
  const stateDir = join(root, 'state');
  const keyPath = join(root, 'keys', 'id_ed25519');
  const scanned = await sshHostKey({ ssh: bench.ssh, host: bench.host, port: 2222, stateDir });
  await scanned.confirm();
  const provider = sshVm({
    ssh: bench.ssh, host: bench.host, port: 2222, user: 'app',
    keyPath, stateDir, label: 'L', ...patch,
  });
  const ref: MachineRef = {
    provider: 'ssh-vm', account: await provider.account(),
    id: await adoptOf(provider), name: 'web', keepCopies: false,
  };
  return { bench, root, stateDir, keyPath, provider, ref, fingerprint: scanned.fingerprint };
}

const sshCallsOf = (bench: FakeSshBench) => bench.calls().filter((c) => c.tool === 'ssh');

async function adoptOf(provider: ReturnType<typeof sshVm>): Promise<string> {
  const adopt = provider.adopt;
  assert.ok(typeof adopt === 'function');
  return adopt();
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; extra: Record<string, string> }> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof MachineError);
    return { code: e.code, extra: { ...e.extra } };
  }
  assert.fail('expected a rejection');
}

test('exec uses the exact 7.1 argv, ssh_config bytes and env', async () => {
  const { bench, stateDir, keyPath, provider, ref, fingerprint } = await confirmed('ssh-argv');
  assert.equal(ref.id, fingerprint);
  bench.script('echo', { code: 0, stdout: 'hello\n', stderr: '', timedOut: false });
  const r = await provider.exec(ref, ['echo', 'hello'], { timeoutMs: 5000 });
  assert.deepEqual(r, { code: 0, stdout: 'hello\n', stderr: '', timedOut: false });

  const calls = sshCallsOf(bench);
  assert.equal(calls.length, 1);
  const [call] = calls;
  const configPath = join(stateDir, 'ssh_config');
  assert.deepEqual(call.argv, [
    '-F', configPath,
    '-p', '2222',
    '--', 'app@vm.test',
    `timeout -k 10 5 'echo' 'hello'`,
  ]);
  assert.deepEqual(call.env, { LANG: 'C.UTF-8' });
  assert.equal(call.stdin, '');
  assert.deepEqual(call.config, { path: configPath, bytes: readFileSync(configPath, 'utf8') });
  assert.equal(
    call.config?.bytes,
    `# written by @byokit/cloud\nIdentityFile "${keyPath}"\nIdentitiesOnly yes\n` +
      `UserKnownHostsFile "${stateDir}/known_hosts"\nStrictHostKeyChecking yes\nUpdateHostKeys no\nBatchMode yes\n`,
  );
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
});

test('a stateDir with a space works', async () => {
  const { bench, root } = benchRoot('ssh-space');
  const stateDir = join(root, 'my state');
  const scanned = await sshHostKey({ ssh: bench.ssh, host: bench.host, stateDir });
  await scanned.confirm();
  const provider = sshVm({
    ssh: bench.ssh, host: bench.host, user: 'app',
    keyPath: join(root, 'id'), stateDir, label: 'L',
  });
  const ref: MachineRef = {
    provider: 'ssh-vm', account: await provider.account(),
    id: await adoptOf(provider), name: 'web', keepCopies: false,
  };
  assert.equal(await provider.status(ref), 'on');
  const config = readFileSync(join(stateDir, 'ssh_config'), 'utf8');
  assert.ok(config.includes(`UserKnownHostsFile "${stateDir}/known_hosts"\n`));
});

test('each 7.1 option rule rejects with its extra.why', async () => {
  const { bench, root } = benchRoot('ssh-opts');
  const good: SshVmOptions = {
    ssh: bench.ssh, host: bench.host, port: 2222, user: 'app',
    keyPath: join(root, 'id'), stateDir: join(root, 'state'), label: 'L',
  };
  const ref: MachineRef = { provider: 'ssh-vm', account: 'app@vm.test:2222', id: 'x', name: 'web', keepCopies: false };
  const cases: [Partial<SshVmOptions>, string][] = [
    [{ ssh: 'relative/ssh' }, 'bin'],
    [{ ssh: join(root, 'missing') }, 'bin'],
    [{ keyPath: 'relative/key' }, 'path'],
    [{ keyPath: join(root, 'a%b') }, 'path'],
    [{ keyPath: join(root, 'a"b') }, 'path'],
    [{ keyPath: join(root, 'a\nb') }, 'path'],
    [{ stateDir: join(root, 'a"b') }, 'path'],
    [{ host: '-evil' }, 'host'],
    [{ host: 'a b' }, 'host'],
    [{ user: 'Root' }, 'user'],
    [{ user: '0app' }, 'user'],
    [{ user: 'a'.repeat(33) }, 'user'],
    [{ port: 0 }, 'port'],
    [{ port: 70000 }, 'port'],
    [{ port: 1.5 }, 'port'],
  ];
  for (const [patch, why] of cases) {
    const provider = sshVm({ ...good, ...patch });
    assert.deepEqual((await codeOf(provider.exec(ref, ['true'], { timeoutMs: 1000 }))).extra, { why }, JSON.stringify(patch));
    assert.equal((await codeOf(provider.exec(ref, ['true'], { timeoutMs: 1000 }))).code, 'unreachable');
    assert.equal((await codeOf(provider.status(ref))).code, 'unreachable');
    assert.deepEqual((await codeOf(provider.status(ref))).extra, { why }, JSON.stringify(patch));
  }
});

test('NUL in argv rejects bad-recipe', async () => {
  const { provider, ref } = await confirmed('ssh-nul');
  assert.equal((await codeOf(provider.exec(ref, ['ok', 'a\0b'], { timeoutMs: 1000 }))).code, 'bad-recipe');
});

test('exit 255 with host-key text is host-key-changed; any other 255 is unreachable', async () => {
  for (const stderr of ['REMOTE HOST IDENTIFICATION HAS CHANGED!', 'Host key verification failed.']) {
    const { bench, stateDir, provider, ref } = await confirmed('ssh-mismatch');
    writeFileSync(join(stateDir, 'known_hosts'), 'vm.test ssh-ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n');
    assert.equal(await provider.status(ref), 'host-key-changed', stderr);
    assert.equal((await codeOf(provider.exec(ref, ['true'], { timeoutMs: 1000 }))).code, 'host-key', stderr);
    void bench;
  }
  const other = await confirmed('ssh-255');
  other.bench.setFail({ code: 255, stderr: 'Connection reset by peer' });
  assert.equal(await other.provider.status(other.ref), 'unknown');
  assert.equal((await codeOf(other.provider.exec(other.ref, ['true'], { timeoutMs: 1000 }))).code, 'unreachable');
});

test('stdout and stderr are capped at 8 MB, tail kept', async () => {
  const { bench, provider, ref } = await confirmed('ssh-cap');
  const out = `${'A'.repeat(CAP)}${'B'.repeat(1024 * 1024)}`;
  const err = `${'c'.repeat(CAP)}${'d'.repeat(1024 * 1024)}`;
  bench.script('big', { code: 0, stdout: out, stderr: err, timedOut: false });
  const r = await provider.exec(ref, ['big'], { timeoutMs: 10_000 });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout.length, CAP);
  assert.equal(r.stderr.length, CAP);
  assert.ok(r.stdout.endsWith('B'.repeat(1024)), 'the tail is kept');
  assert.ok(r.stdout.startsWith('A'), 'the head is dropped');
  assert.ok(r.stderr.endsWith('d'.repeat(1024)));
});

test('the timeout wrapper names ceiling seconds; a hung ssh hits the local backstop', async () => {
  const { bench, provider, ref } = await confirmed('ssh-timeout');
  bench.script('echo', { code: 0, stdout: '', stderr: '', timedOut: false });
  await provider.exec(ref, ['echo'], { timeoutMs: 61_000 });
  const last = sshCallsOf(bench).at(-1);
  assert.ok(last?.argv[6].startsWith('timeout -k 10 61 '), last?.argv[6]);

  bench.setHang(true);
  const started = Date.now();
  const r = await provider.exec(ref, ['true'], { timeoutMs: 100 });
  assert.equal(r.timedOut, true);
  // SIGTERM at timeoutMs + 15 s, SIGKILL 2 s later: the wait is the proof.
  assert.ok(Date.now() - started >= 15_000, `${Date.now() - started}ms`);
});

test('root prefixes sudo -n except for user root', async () => {
  const plain = await confirmed('ssh-sudo-alice');
  plain.bench.script('id', { code: 0, stdout: 'uid=0\n', stderr: '', timedOut: false });
  await plain.provider.exec(plain.ref, ['id'], { timeoutMs: 5000, root: true });
  await plain.provider.exec(plain.ref, ['id'], { timeoutMs: 5000 });
  const alice = sshCallsOf(plain.bench).map((c) => c.argv[6]);
  assert.deepEqual(alice, ['sudo -n timeout -k 10 5 \'id\'', 'timeout -k 10 5 \'id\'']);

  const { bench, root } = benchRoot('ssh-sudo-root');
  const stateDir = join(root, 'state');
  const scanned = await sshHostKey({ ssh: bench.ssh, host: bench.host, stateDir });
  await scanned.confirm();
  const provider = sshVm({
    ssh: bench.ssh, host: bench.host, user: 'root',
    keyPath: join(root, 'id'), stateDir, label: 'L',
  });
  const ref: MachineRef = {
    provider: 'ssh-vm', account: await provider.account(),
    id: await adoptOf(provider), name: 'web', keepCopies: false,
  };
  bench.script('id', { code: 0, stdout: 'uid=0\n', stderr: '', timedOut: false });
  await provider.exec(ref, ['id'], { timeoutMs: 5000, root: true });
  assert.deepEqual(
    sshCallsOf(bench).map((c) => c.argv[6]),
    ['timeout -k 10 5 \'id\''],
  );
});

test('calls and adoption before confirm() reject host-key; status is unknown', async () => {
  const { bench, root } = benchRoot('ssh-first');
  const stateDir = join(root, 'state');
  const provider = sshVm({
    ssh: bench.ssh, host: bench.host, port: 2222, user: 'app',
    keyPath: join(root, 'id'), stateDir, label: 'L',
  });
  const ref: MachineRef = { provider: 'ssh-vm', account: 'app@vm.test:2222', id: 'x', name: 'web', keepCopies: false };
  assert.equal((await codeOf(provider.exec(ref, ['true'], { timeoutMs: 1000 }))).code, 'host-key');
  assert.equal((await codeOf(provider.write(ref, '/home/user/a.txt', new Uint8Array([1]), 0o600))).code, 'host-key');
  assert.equal((await codeOf(adoptOf(provider))).code, 'host-key');
  assert.equal(await provider.status(ref), 'unknown');
  assert.equal(await provider.account(), 'app@vm.test:2222');
});

test('write sends the 7.1 shell with input on stdin', async () => {
  const { bench, stateDir, provider, ref } = await confirmed('ssh-write');
  bench.script('sh', { code: 0, stdout: '', stderr: '', timedOut: false });
  await provider.write(ref, '/home/user/a.txt', new TextEncoder().encode('hi'), 0o600);
  const last = sshCallsOf(bench).at(-1);
  assert.ok(last !== undefined);
  assert.deepEqual(last.argv.slice(0, 6), [
    '-F', join(stateDir, 'ssh_config'),
    '-p', '2222',
    '--', 'app@vm.test',
  ]);
  assert.equal(
    last.argv[6],
    'timeout -k 10 30 \'sh\' \'-c\' \'umask 077 && t=$(mktemp "$(dirname "$1")/.byokit-XXXXXX") && ' +
      'cat > "$t" && chmod "$2" "$t" && mv -f "$t" "$1"\' \'sh\' \'/home/user/a.txt\' \'600\'',
  );
  assert.equal(Buffer.from(last.stdin, 'base64').toString('utf8'), 'hi');
  assert.deepEqual(last.env, { LANG: 'C.UTF-8' });
});

test('sshHostKey passes -- before the host, prefers ed25519, reports pinned, and confirm() writes one line at 0600', async () => {
  const { bench, root } = benchRoot('ssh-keyscan');
  const stateDir = join(root, 'state');
  const first = await sshHostKey({ ssh: bench.ssh, host: bench.host, stateDir });
  assert.equal(first.fingerprint, fakeKeyFingerprint(bench.hostKeys.ed25519));
  assert.equal(first.pinned, false);
  const scans = bench.calls().filter((c) => c.tool === 'ssh-keyscan');
  assert.equal(scans.length, 1);
  assert.deepEqual(scans[0].argv, ['-p', '22', '-t', 'ed25519,ecdsa,rsa', '--', bench.host]);
  assert.deepEqual(scans[0].env, { LANG: 'C.UTF-8' });
  await first.confirm();
  const knownHosts = join(stateDir, 'known_hosts');
  assert.equal(readFileSync(knownHosts, 'utf8'), `${bench.host} ssh-ed25519 ${bench.hostKeys.ed25519}\n`);
  assert.equal(statSync(knownHosts).mode & 0o777, 0o600);
  const second = await sshHostKey({ ssh: bench.ssh, host: bench.host, stateDir });
  assert.equal(second.pinned, true);
  assert.equal(second.fingerprint, first.fingerprint);
});
