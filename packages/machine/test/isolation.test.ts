// The SSH adapter's isolation guarantee (docs/machine-kit.md 13.2), modelled on
// packages/accounts/test/isolation.test.ts: a decoy HOME whose `.ssh` holds its
// own config, private key and known_hosts, an fs tracer watching that `.ssh`,
// and the SSH contract running in a child against the fake `ssh` bench. The run
// must leave the canaries byte for byte, never touch them at all, spawn `ssh`
// with exactly the 7.1 argv, and hand it exactly `{ LANG: 'C.UTF-8' }`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { decoy, traceFs } from '../../accounts/src/testing/index.ts';
import { readFakeSshCalls } from '../src/testing/fake-ssh.ts';

const RUNNER = [
  "import { machineContract } from '__REPO__/packages/machine/src/testing/contract.ts';",
  "import type { MachineBench } from '__REPO__/packages/machine/src/testing/contract.ts';",
  "import { memoryStore } from '__REPO__/packages/machine/src/testing/fake-provider.ts';",
  "import { sshVm, sshHostKey } from '__REPO__/packages/machine/src/ssh.ts';",
  "import { setupFakeSsh } from '__REPO__/packages/machine/src/testing/fake-ssh.ts';",
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  '',
  'const fakeDir = process.env.FAKE_DIR as string;',
  "const bench = setupFakeSsh(join(fakeDir, 'fake'));",
  "const keyPath = join(fakeDir, 'id_ed25519');",
  "writeFileSync(keyPath, 'fake-private-key\\n');",
  'const monthly = {',
  "  size: 'vm', perMonthCap: 6, asleepPerHour: 6, currency: 'EUR',",
  "  basis: 'incl. IPv4, excl. VAT', source: 'http://sandbox.test/prices',",
  '  checked: new Date().toISOString().slice(0, 10),',
  '};',
  'let benchNo = 0;',
  'const queue: Array<{ name: string; fn: (t: { skip: (message?: string) => void }) => void | Promise<void> }> = [];',
  'machineContract(async (): Promise<MachineBench> => {',
  '  benchNo += 1;',
  "  const stateDir = join(fakeDir, 'state-' + String(benchNo));",
  '  const scanned = await sshHostKey({ ssh: bench.ssh, host: bench.host, port: 2222, stateDir });',
  '  await scanned.confirm();',
  '  const provider = sshVm({',
  '    ssh: bench.ssh, host: bench.host, port: 2222, user: \'app\',',
  "    keyPath, stateDir, label: 'Fake VM', monthly,",
  '  });',
  '  return { provider, store: memoryStore(), installs: false };',
  '}, (name, fn) => {',
  '  queue.push({ name, fn });',
  '});',
  '',
  "const SKIP = 'skip-contract-case';",
  'const results: Array<{ name: string; outcome: string; error?: string }> = [];',
  'for (const item of queue) {',
  '  try {',
  '    await item.fn({ skip: () => { throw new Error(SKIP); } });',
  "    results.push({ name: item.name, outcome: 'pass' });",
  '  } catch (e) {',
  "    if (e instanceof Error && e.message === SKIP) results.push({ name: item.name, outcome: 'skip' });",
  "    else results.push({ name: item.name, outcome: 'fail', error: String((e as Error)?.stack ?? e) });",
  '  }',
  '}',
  "process.stdout.write(JSON.stringify({ results }) + '\\n');",
  "if (results.some((r) => r.outcome === 'fail')) process.exitCode = 1;",
].join('\n');

test("the SSH adapter never touches the owner's ~/.ssh and spawns ssh exactly per 7.1", () => {
  const repo = resolve(import.meta.dirname, '..', '..', '..');
  const scratch = scratchDir('ssh-isolation');
  const decoyRoot = join(scratch, 'decoy');
  mkdirSync(decoyRoot, { recursive: true });
  const d = decoy(decoyRoot);
  const sshRoot = join(d.home, '.ssh');
  mkdirSync(sshRoot, { recursive: true });
  const canaries: Record<string, string> = {
    config: 'Host owners-laptop\n  IdentityFile ~/.ssh/id_ed25519\n',
    id_ed25519: 'fake-owner-private-key\n',
    known_hosts: 'owners-laptop ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA FakeOwner\n',
  };
  for (const [name, text] of Object.entries(canaries)) writeFileSync(join(sshRoot, name), text);
  const hashOf = (name: string): string => createHash('sha256').update(readFileSync(join(sshRoot, name))).digest('hex');

  const before = Object.fromEntries(Object.keys(canaries).map((name) => [name, hashOf(name)]));
  const fakeDir = join(scratch, 'bench');
  mkdirSync(fakeDir, { recursive: true });
  const traceLog = join(scratch, 'trace.log');
  writeFileSync(traceLog, '');
  const runner = join(scratch, 'run.ts');
  writeFileSync(runner, RUNNER.replaceAll('__REPO__', repo));

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: d.home,
    TRACE_ROOTS: sshRoot,
    TRACE_LOG: traceLog,
    FAKE_DIR: fakeDir,
  };
  if (process.env.NODE_OPTIONS !== undefined) env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--import', traceFs, runner], { env, encoding: 'utf8', timeout: 180_000 });
  assert.equal(r.status, 0, `child failed: status=${String(r.status)} signal=${String(r.signal)}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const summary = JSON.parse(r.stdout.trim().split('\n').pop()!) as {
    results: Array<{ name: string; outcome: string; error?: string }>;
  };
  const failed = summary.results.filter((c) => c.outcome === 'fail');
  assert.deepEqual(failed, [], 'the SSH contract passes in the child');
  assert.ok(summary.results.some((c) => c.outcome === 'pass'), 'the child ran contract cases');

  for (const name of Object.keys(canaries)) {
    assert.equal(hashOf(name), before[name], `${name} changed byte for byte`);
  }
  assert.equal(readFileSync(traceLog, 'utf8').trim(), '', 'the tracer saw a touch under the owner’s .ssh');

  const calls = readFakeSshCalls(join(fakeDir, 'fake'));
  const sshCalls = calls.filter((c) => c.tool === 'ssh');
  const keyscanCalls = calls.filter((c) => c.tool === 'ssh-keyscan');
  assert.ok(sshCalls.length >= 3, `the child really spawned ssh (${sshCalls.length} calls)`);
  for (const c of sshCalls) {
    assert.equal(c.argv.length, 7, JSON.stringify(c.argv));
    assert.equal(c.argv[0], '-F');
    assert.ok(c.argv[1].endsWith('/ssh_config'), c.argv[1]);
    assert.deepEqual([c.argv[2], c.argv[4]], ['-p', '--']);
    assert.match(c.argv[3], /^\d+$/);
    assert.match(c.argv[5], /^[^@\s]+@[^@\s]+$/);
    assert.deepEqual(c.env, { LANG: 'C.UTF-8' });
    assert.ok(c.config !== null && c.config.bytes !== null && c.config.bytes.includes('written by @byokit/machine'));
  }
  for (const c of keyscanCalls) {
    assert.deepEqual(c.argv, ['-p', '2222', '-t', 'ed25519,ecdsa,rsa', '--', 'vm.test']);
    assert.deepEqual(c.env, { LANG: 'C.UTF-8' });
  }
});
