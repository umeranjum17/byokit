// Remote agent-CLI sign-in over a paired link: fake native CLIs stand in for Codex's device-code
// login and Claude's link-and-paste-code login; a thin stub link carries the same op/args/reply
// contract `@byokit/pair` seals on the wire. No account, no network, no real credential anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { cliAccounts, remoteCliHost, signInLock } from '../src/cli.ts';
import { REMOTE_CLI_OPS, remoteCliDevice, type RemoteCliLink, type RemoteCliProvider } from '../src/remote-cli.ts';
import { scratchDir } from '../../test-support.ts';

const TOKEN = 'private-fake-token';
const EMAIL = 'alice.work@example.test';

function fakeCodex(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'codex-fake');
  const log = join(dir, 'codex.jsonl');
  writeFileSync(log, '');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = process.env.CODEX_HOME || '';
const granted = home ? require('node:path').join(home, 'granted') : '';
(async () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
  const mode = process.env.LOGIN_MODE || 'success';
  if (process.argv[2] === 'app-server') {
    let b = '';
    process.stdin.on('data', (c) => {
      b += c;
      for (;;) {
        const i = b.indexOf('\\n'); if (i < 0) break;
        const r = JSON.parse(b.slice(0, i)); b = b.slice(i + 1);
        const account = granted && fs.existsSync(granted)
          ? { email: ${JSON.stringify(EMAIL)}, planType: 'plus', subscriptionType: 'pro', access_token: ${JSON.stringify(TOKEN)} }
          : undefined;
        console.log(JSON.stringify({ id: r.id, result: r.id === 1 ? {} : account === undefined ? {} : { account } }));
      }
    });
    return;
  }
  if (process.argv[2] === 'login') {
    const expiry = process.env.CODE_EXPIRY || '300';
    const page = 'Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n' +
      '1. Open this link in your browser and sign in to your account\\n' +
      '   \\x1b[94mhttps://auth.example.test/codex/device\\x1b[0m\\n\\n' +
      '2. Enter this one-time code (expires in ' + expiry + ' seconds)\\n' +
      '   ABCD-12345\\n';
    if (mode === 'silent') { console.log('hello'); return; }
    process.stdout.write(page);
    if (mode === 'hang') { await sleep(30000); return; }
    if (mode === 'denied') { await sleep(200); process.stdout.write('the sign-in was denied\\n'); process.exitCode = 1; return; }
    if (mode === 'expired') { await sleep(1500); process.stdout.write('the code expired\\n'); process.exitCode = 1; return; }
    await sleep(200);
    if (granted) fs.writeFileSync(granted, '');
    return;
  }
})();
`, { mode: 0o755 });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { bin, calls };
}

function fakeClaude(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'claude-fake');
  const log = join(dir, 'claude.jsonl');
  writeFileSync(log, '');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = process.env.CLAUDE_CONFIG_DIR || '';
const granted = home ? require('node:path').join(home, 'granted') : '';
(async () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), home }) + '\\n');
  const mode = process.env.LOGIN_MODE || 'success';
  if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
    const on = granted && fs.existsSync(granted);
    if (process.env.STATUS_WAIT_FILE) {
      fs.writeFileSync(process.env.STATUS_WAIT_FILE, '');
      while (!fs.existsSync(process.env.STATUS_WAIT_FILE + '.release')) await sleep(10);
    }
    console.log(JSON.stringify(on
      ? { loggedIn: true, email: ${JSON.stringify(EMAIL)}, planType: 'plus', subscriptionType: 'pro', access_token: ${JSON.stringify(TOKEN)} }
      : { loggedIn: false }));
    return;
  }
  if (process.argv[2] === 'auth' && process.argv[3] === 'login') {
    if (process.env.LOGIN_PID_FILE) fs.writeFileSync(process.env.LOGIN_PID_FILE, String(process.pid));
    process.stdout.write("Opening browser to sign in\\u2026\\nIf the browser didn't open, visit: https://claude.example.test/authorize?code=abc\\nPaste code here if prompted > ");
    if (mode === 'denied') { await sleep(200); process.stdout.write('sign-in declined\\n'); process.exitCode = 1; return; }
    if (mode === 'paste') {
      let b = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', async (c) => {
        b += c;
        const i = b.indexOf('\\n'); if (i < 0) return;
        if (b.slice(0, i).trim() === (process.env.EXPECT_CODE || '')) { if (granted) fs.writeFileSync(granted, ''); process.exitCode = 0; }
        else { process.stdout.write('that code was declined\\n'); process.exitCode = 1; }
        process.exit();
      });
      await sleep(10000); process.exitCode = 1; return;
    }
    await sleep(200);
    if (granted) fs.writeFileSync(granted, '');
    return;
  }
})();
`, { mode: 0o755 });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { bin, calls };
}

function fakePi(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'pi-fake');
  const log = join(dir, 'pi.jsonl');
  writeFileSync(log, '');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
if (process.argv[2] === 'auth' && process.argv[3] === 'check') {
  console.log(JSON.stringify({ status: 'ready', provider: process.argv[process.argv.indexOf('--provider') + 1], authType: 'oauth', access_token: ${JSON.stringify(TOKEN)} }));
}
`, { mode: 0o755 });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { bin, calls };
}

function kitAndHost(root: string, bins: Partial<Record<RemoteCliProvider, string>>, extraEnv: Record<string, string> = {}, now?: () => number) {
  const stateDir = join(root, 'plans');
  mkdirSync(stateDir, { recursive: true });
  const env = { HOME: join(root, 'home'), PATH: '/unused', ...extraEnv };
  const cli = cliAccounts({ stateDir, bins, env });
  const host = remoteCliHost({ cli, bins, now });
  const seen: unknown[] = [];
  const link: RemoteCliLink = {
    status: 'online',
    request: async (op: string, args?: unknown) => {
      const reply = await host.handle({ op, args });
      seen.push(reply);
      return reply;
    },
  };
  return { stateDir, cli, host, device: remoteCliDevice(link), seen };
}

const repliesClean = (seen: unknown[]) => assert.doesNotMatch(JSON.stringify(seen), new RegExp(TOKEN), 'no credential in any reply');

test('read-only state reports every CLI without writing or logging secrets', async () => {
  const root = scratchDir('remote-state');
  const codex = fakeCodex(join(root, 'bins'));
  const claude = fakeClaude(join(root, 'bins'));
  const pi = fakePi(join(root, 'bins'));
  const { stateDir, cli, device, seen } = kitAndHost(root, { codex: codex.bin, claude: claude.bin, pi: pi.bin });
  const before = await device.state();
  const shape = (r: { provider: unknown; billing: unknown; installed: unknown; signedIn: unknown; supported: unknown }) =>
    ({ provider: r.provider, billing: r.billing, installed: r.installed, signedIn: r.signedIn, supported: r.supported });
  assert.deepEqual(before.map(shape), [
    { provider: 'claude', billing: 'subscription', installed: true, signedIn: false, supported: true },
    { provider: 'codex', billing: 'subscription', installed: true, signedIn: false, supported: true },
    { provider: 'pi', billing: 'subscription', installed: true, signedIn: false, supported: false },
    { provider: 'opencode', billing: 'subscription', installed: false, signedIn: false, supported: false },
  ]);
  // Nothing written: no roster, no markers; only status reads ran.
  assert.deepEqual(readdirSync(stateDir), []);
  assert.ok(codex.calls().every((c) => c.argv[0] === 'app-server'));
  assert.ok(claude.calls().every((c) => c.argv.join(' ') === 'auth status'));
  assert.ok(pi.calls().every((c) => c.argv.includes('--no-refresh')), 'Pi status never refreshes');
  repliesClean(seen);
  // After each CLI's own login, state names the account without secrets.
  const logins = await cli.add('pi', { piProvider: 'openai-codex', model: 'chosen-model' });
  writeFileSync(logins.signIn.completion, 'complete', { mode: 0o600 });
  for (const bin of [codex, claude]) {
    const { account, signIn } = bin === codex ? await cli.add('codex') : await cli.add('claude');
    const folder = Object.values(cli.launchEnv(account.id, 'chosen-model').set)[0];
    const homeVar = bin === codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    assert.equal(signIn.env[homeVar], folder);
    writeFileSync(join(folder, 'granted'), '');
    writeFileSync(signIn.completion, 'complete', { mode: 0o600 });
  }
  const after = await device.state();
  assert.equal(after.find((r) => r.provider === 'codex')?.signedIn, true);
  assert.equal(after.find((r) => r.provider === 'codex')?.label, EMAIL);
  assert.equal(after.find((r) => r.provider === 'codex')?.plan, 'plus');
  assert.equal(after.find((r) => r.provider === 'claude')?.label, EMAIL);
  assert.equal(after.find((r) => r.provider === 'pi')?.signedIn, true);
  assert.doesNotMatch(JSON.stringify(after), new RegExp(TOKEN));
  repliesClean(seen);
});

test('exact native re-auth keeps two Claude folders and the selected row through cancel and restart', async () => {
  const root = scratchDir('remote-exact-claude');
  const claude = fakeClaude(join(root, 'bins'));
  const bins = { claude: claude.bin };
  const env = { HOME: join(root, 'home'), PATH: '/unused', LOGIN_MODE: 'paste', EXPECT_CODE: 'synthetic' };
  const stateDir = join(root, 'plans'); mkdirSync(stateDir);
  let cli = cliAccounts({ stateDir, bins, env });
  let host = remoteCliHost({ cli, bins });
  const a = (await cli.add('claude')).account.id;
  const b = (await cli.add('claude')).account.id;
  const folders = [cli.folderOf(a), cli.folderOf(b)];
  assert.notEqual(folders[0], folders[1]);
  const login = async (id: string) => {
    const started = await host.start('claude', { account: id }); assert.ok(started.ok);
    assert.equal(started.signIn.id, id);
    await host.paste(id, 'synthetic'); assert.equal((await host.wait(id)).ok, true);
  };
  try {
    await login(a);
    const before = claude.calls().length;
    await login(b); // A being ready must neither block nor replace B.
    assert.ok(claude.calls().slice(before).every(c => c.home === folders[1]));
    const again = await host.start('claude', { account: b }); assert.ok(again.ok);
    assert.deepEqual(await host.start('claude', { account: a }).then(r => r.ok ? 'ok' : r.error), 'busy');
    await host.cancel(b);
    assert.equal((await host.wait(b)).ok, false);
    assert.equal(cli.folderOf(b), folders[1], 'cancel retains a row even in its allocating instance');
    assert.equal((await cli.status(a)).state, 'ready');
    assert.equal((await cli.list()).length, 2);
    await assert.rejects(host.start('claude', { account: 'missing' }), { code: 'unknown-account' });
    const beforeInstalled = claude.calls().length;
    await assert.rejects(host.start('claude', { account: 'installed-claude' }), { code: 'unknown-account' });
    assert.equal(claude.calls().length, beforeInstalled, 'installed login is not even probed for re-auth');
    await assert.rejects(host.start('codex', { account: a }), { code: 'kind-mismatch' });
    await host.close();
    cli = cliAccounts({ stateDir, bins, env }); host = remoteCliHost({ cli, bins });
    await login(b);
    assert.equal(cli.folderOf(b), folders[1]);
    assert.equal((await cli.status(a)).state, 'ready');
    assert.deepEqual(await host.start('claude').then(r => r.ok ? 'ok' : r.error), 'already', 'legacy start is unchanged');
  } finally { await host.close(); }
});

test('codex device code succeeds over the link and the credential stays on the host', async () => {
  const root = scratchDir('remote-codex-ok');
  const codex = fakeCodex(join(root, 'bins'));
  const { cli, device, seen } = kitAndHost(root, { codex: codex.bin });
  const started = await device.start('codex');
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.match(started.signIn.verificationUri, /^https:\/\//);
  assert.equal(started.signIn.userCode, 'ABCD-12345');
  assert.ok((started.signIn.expiresInSeconds ?? 0) > 0);
  const result = await device.wait(started.signIn.id);
  assert.deepEqual(result, { ok: true, provider: 'codex' });
  const account = await cli.status(started.signIn.id);
  assert.equal(account.state, 'ready');
  assert.equal(account.email, EMAIL);
  const folder = cli.launchEnv(started.signIn.id).set.CODEX_HOME;
  assert.ok(existsSync(join(folder, '.byokit-signin-complete')));
  assert.equal((await device.state()).find((r) => r.provider === 'codex')?.signedIn, true);
  repliesClean(seen);
});

test('codex denial and expiry report plain failures and clean up', async () => {
  const root = scratchDir('remote-codex-no');
  const codex = fakeCodex(join(root, 'bins'));
  const denied = kitAndHost(join(root, 'd1'), { codex: codex.bin }, { LOGIN_MODE: 'denied' });
  const startDenied = await denied.device.start('codex');
  assert.equal(startDenied.ok, true);
  if (!startDenied.ok) return;
  const deniedResult = await denied.device.wait(startDenied.signIn.id);
  assert.equal(deniedResult.ok, false);
  if (deniedResult.ok) return;
  assert.equal(deniedResult.error, 'denied');
  assert.match(deniedResult.words, /declined/);
  assert.deepEqual((await denied.cli.list()).filter((r) => r.provider === 'codex'), [], 'a denied login leaves no row');
  const expired = kitAndHost(join(root, 'd2'), { codex: codex.bin }, { LOGIN_MODE: 'expired', CODE_EXPIRY: '1' });
  const startExpired = await expired.device.start('codex');
  assert.equal(startExpired.ok, true);
  if (!startExpired.ok) return;
  const expiredResult = await expired.device.wait(startExpired.signIn.id);
  assert.equal(expiredResult.ok, false);
  if (expiredResult.ok) return;
  assert.equal(expiredResult.error, 'expired');
  assert.match(expiredResult.words, /ran out/);
  repliesClean([...denied.seen, ...expired.seen]);
});

test('claude link-and-paste-code succeeds; denial fails plainly', async () => {
  const root = scratchDir('remote-claude');
  const claude = fakeClaude(join(root, 'bins'));
  const ok = kitAndHost(join(root, 'ok'), { claude: claude.bin }, { LOGIN_MODE: 'paste', EXPECT_CODE: 'good#state' });
  const started = await ok.device.start('claude');
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.match(started.signIn.verificationUri, /^https:\/\/claude\.example\.test\//);
  assert.equal(started.signIn.userCode, undefined, 'the page shows the code; the phone sends it back');
  await ok.device.paste(started.signIn.id, 'good#state');
  assert.deepEqual(await ok.device.wait(started.signIn.id), { ok: true, provider: 'claude' });
  const no = kitAndHost(join(root, 'no'), { claude: claude.bin }, { LOGIN_MODE: 'denied' });
  const startedNo = await no.device.start('claude');
  assert.equal(startedNo.ok, true);
  if (!startedNo.ok) return;
  const result = await no.device.wait(startedNo.signIn.id);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, 'denied');
  repliesClean([...ok.seen, ...no.seen]);
});

test('missing CLI and Pi report plainly; Pi login never starts', async () => {
  const root = scratchDir('remote-missing');
  const pi = fakePi(join(root, 'bins'));
  const { device, seen } = kitAndHost(root, { pi: pi.bin });
  const missing = await device.start('codex');
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.error, 'missing');
  assert.match(missing.words, /isn't installed/);
  assert.equal((await device.state()).find((r) => r.provider === 'codex')?.installed, false);
  const unsupported = await device.start('pi');
  assert.equal(unsupported.ok, false);
  if (unsupported.ok) return;
  assert.equal(unsupported.error, 'unsupported');
  assert.match(unsupported.words, /can't sign in from your phone/);
  assert.ok(pi.calls().every((c) => c.argv[1] === 'check'), 'only status reads run against Pi');
  repliesClean(seen);
});

test('cancel stops a hanging login; unknown ids and bad ops fail plainly', async () => {
  const root = scratchDir('remote-cancel');
  const codex = fakeCodex(join(root, 'bins'));
  const { cli, host, device, seen } = kitAndHost(root, { codex: codex.bin }, { LOGIN_MODE: 'hang', CODE_EXPIRY: '300' });
  const started = await device.start('codex');
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const id = started.signIn.id;
  const second = await device.start('codex');
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error, 'busy');
  await device.cancel(id);
  assert.deepEqual(await device.wait(id), { ok: false, error: 'cancelled', words: 'The sign-in was stopped.' });
  assert.deepEqual(await cli.list(), [], 'a cancelled login leaves no row');
  const unknown = await device.wait('pa_nosuchrow');
  assert.equal(unknown.ok, false);
  if (unknown.ok) return;
  assert.equal(unknown.error, 'unknown');
  await assert.rejects(host.handle({ op: REMOTE_CLI_OPS.start, args: { v: 1 } }), /needs \{ provider \}/);
  await assert.rejects(host.handle({ op: 'accounts.cli.nope', args: { v: 1 } }), /unknown request/);
  await assert.rejects(device.start('other' as RemoteCliProvider), /Unknown agent app/);
  repliesClean(seen);
});

test('a runtime-owned folder survives timeout and close; closing wins over late native status', async () => {
  const root = scratchDir('remote-runtime');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude'); mkdirSync(folder);
  const canary = join(folder, 'host-owned'); writeFileSync(canary, 'keep');
  const bins = { claude: native.bin };
  const cli = cliAccounts({ stateDir, bins, env: { HOME: home, PATH: '/unused', LOGIN_MODE: 'paste' }, managedFolders: { claude: folder } });
  const host = remoteCliHost({ cli, bins, waitCapMs: 60 });
  try {
    const started = await host.start('claude'); assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(cli.launchEnv(started.signIn.id).set.CLAUDE_CONFIG_DIR, folder);
    const end = await host.wait(started.signIn.id); assert.equal(end.ok, false);
    if (!end.ok) assert.equal(end.error, 'expired');
    assert.deepEqual(await cli.list(), []);
    assert.equal(readFileSync(canary, 'utf8'), 'keep');
    const next = await host.start('claude'); assert.equal(next.ok, true);
    await host.close();
    assert.deepEqual(await cli.list(), []);
    assert.equal(readFileSync(canary, 'utf8'), 'keep');
    assert.ok(!existsSync(join(folder, 'granted')));
    const readFlag = join(root, 'status-inflight');
    const race = remoteCliHost({ bins, cli: cliAccounts({ stateDir, bins,
      env: { HOME: home, PATH: '/unused', STATUS_WAIT_FILE: readFlag }, managedFolders: { claude: folder } }) });
    const signed = await race.start('claude'); assert.ok(signed.ok);
    if (!signed.ok) return;
    const waiting = race.wait(signed.signIn.id);
    for (let i = 0; !existsSync(readFlag) && i < 300; i++) await delay(10);
    assert.ok(existsSync(readFlag), 'native status read is in flight');
    const closing = race.close();
    writeFileSync(readFlag + '.release', '');
    const result = await waiting;
    await closing;
    assert.equal(result.ok, false, 'closing the host wins over a late successful native status read');
    if (!result.ok) assert.equal(result.error, 'cancelled');
    assert.equal(readFileSync(canary, 'utf8'), 'keep');
  } finally { await host.close(); }
});

test('a long phone wait does not accumulate native-child exit listeners', { timeout: 10_000 }, async (t) => {
  const root = scratchDir('remote-wait-listeners');
  const native = fakeClaude(join(root, 'bins'));
  let now = 0;
  const { host } = kitAndHost(root, { claude: native.bin }, { LOGIN_MODE: 'paste' }, () => now);
  const warnings: string[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning.message);
  };
  process.on('warning', onWarning);
  try {
    const started = await host.start('claude'); assert.ok(started.ok);
    if (!started.ok) return;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const waiting = host.wait(started.signIn.id, { timeoutMs: 3300 });
    for (let i = 0; i < 14; i++) { now += 250; t.mock.timers.tick(250); await turn(); }
    const result = await waiting;
    assert.equal(result.ok ? 'ok' : result.error, 'expired');
    assert.deepEqual(warnings, [], 'polling a live native login must not attach another exit listener');
  } finally { process.off('warning', onWarning); await host.close(); await turn(); t.mock.timers.reset(); }
});

test('cleanup failure with no phone waiter cannot crash the native sign-in host', { timeout: 15_000 }, async () => {
  const root = scratchDir('remote-detached-cleanup');
  const native = fakeClaude(join(root, 'bins'));
  const folder = join(root, 'runtime', 'claude');
  const script = `
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { cliAccounts, remoteCliHost } from ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)};
const root = ${JSON.stringify(root)}, folder = ${JSON.stringify(folder)};
const home = root + '/runtime/home', flag = root + '/status-wait';
mkdirSync(home, { recursive: true });
const bins = { claude: ${JSON.stringify(native.bin)} };
const cli = cliAccounts({ stateDir: root + '/runtime', bins, env: { HOME: home, PATH: '/unused', STATUS_WAIT_FILE: flag }, managedFolders: { claude: folder } });
const host = remoteCliHost({ cli, bins });
try {
  const started = await host.start('claude'); assert.ok(started.ok);
  for (let i = 0; !existsSync(flag) && i < 300; i++) await delay(10);
  assert.ok(existsSync(flag), 'the native child exited and status is settling');
  chmodSync(folder, 0o500);
  writeFileSync(flag + '.release', '');
  // A serialized status probe and an event-loop turn let cleanup finish without observing host.wait.
  // No unhandledRejection handler: the broken host still terminates this process.
  await cli.status(started.signIn.id).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const result = await host.wait(started.signIn.id);
  assert.equal(result.ok ? 'ok' : result.error, 'failed');
  console.log('cleanup failure reported without crashing');
} finally { chmodSync(folder, 0o700); await host.close(); }
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise<number | null>(resolve => child.once('close', resolve));
  if (existsSync(folder)) chmodSync(folder, 0o700);
  assert.equal(code, 0, output);
  assert.match(output, /cleanup failure reported without crashing/);
});

test('a failed fresh holder claim cancels its newly added row without spawning', async () => {
  const root = scratchDir('remote-fresh-claim');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'), home = join(stateDir, 'home'); mkdirSync(home, { recursive: true });
  const folder = join(stateDir, 'claude'), bins = { claude: native.bin };
  const cli = cliAccounts({ stateDir, bins, env: { HOME: home, PATH: '/unused' }, managedFolders: { claude: folder },
    prepare: async () => { mkdirSync(signInLock(folder).lock); writeFileSync(signInLock(folder).holder, '0', { mode: 0o400 }); } });
  const host = remoteCliHost({ cli, bins });
  try {
    const result = await host.start('claude');
    assert.equal(result.ok ? 'ok' : result.error, 'busy', 'an unreadable holder is a live login, so the new row is cancelled');
    assert.deepEqual(await cli.list(), [], 'a phone that never got a login must not leave a signing row');
    assert.equal(existsSync(join(folder, '.byokit-signin-pending')), false);
    assert.equal(native.calls().filter(c => c.argv[1] === 'login').length, 0);
  } finally { await host.close(); }
});

test('shell and phone sign-in share a live native holder and release it before phone retry', { timeout: 10_000 }, async () => {
  const root = scratchDir('remote-shell-holder');
  const native = fakeClaude(join(root, 'bins'));
  const pidFile = join(root, 'native.pid');
  const { cli, host } = kitAndHost(root, { claude: native.bin }, { LOGIN_MODE: 'paste', LOGIN_PID_FILE: pidFile });
  const added = await cli.add('claude');
  const { lock, holder } = signInLock(join(added.signIn.completion, '..'));
  const shell = spawn('/bin/sh', ['-c', added.signIn.shell], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise<void>(resolve => shell.once('close', () => resolve()));
  let pid: number | undefined;
  try {
    for (let i = 0; !native.calls().some(c => c.argv[1] === 'login') && i < 300; i++) await delay(10);
    assert.ok(existsSync(holder), 'the shell records the native login holder, so a crash is recoverable');
    pid = Number(readFileSync(holder, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.notEqual(pid, shell.pid, 'the holder is the native CLI, not its shell wrapper');
    const live = await host.start('claude');
    assert.equal(live.ok ? 'ok' : live.error, 'busy');
    process.kill(pid, 'SIGTERM');
    await exited;
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(holder), false);
    assert.equal((await host.start('claude')).ok, true);
  } finally {
    if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await exited; await host.close();
  }
});

test('a signing row left by a crashed login is retried only once its sign-in lock holder is gone', async () => {
  const root = scratchDir('remote-stale-signing');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  const bins = { claude: native.bin };
  const env = { HOME: home, PATH: '/unused', LOGIN_MODE: 'paste' };
  const crashed = cliAccounts({ stateDir, bins, env, managedFolders: { claude: folder } });
  assert.equal((await crashed.add('claude')).account.state, 'signing');
  const cli = cliAccounts({ stateDir, bins, env, managedFolders: { claude: folder } });
  const host = remoteCliHost({ cli, bins, waitCapMs: 60_000 });
  const { lock, holder } = signInLock(folder);
  const outcome = async () => { const r = await host.start('claude'); return r.ok ? 'ok' : r.error; };
  try {
    mkdirSync(lock);
    assert.equal(await outcome(), 'busy', 'a lock with no holder record is a live or shell-held login');
    writeFileSync(holder, String(process.pid));
    assert.equal(await outcome(), 'busy', 'a live holder keeps the row busy');
    rmSync(holder, { force: true }); rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(holder, String(spawnSync(process.execPath, ['-e', '']).pid));
    assert.equal(await outcome(), 'ok', 'a dead holder is a crash left behind, so the next start retries');
    assert.equal(readdirSync(folder).some(n => n.endsWith('.stale')), false, 'the reclaimed lock leaves no stale copy');
    assert.equal(await outcome(), 'busy', 'the retried login now holds the lock');
  } finally { await host.close(); }
});

test('a login still dying after cancel keeps its sign-in lock: the next start is busy until its child exits', async () => {
  const root = scratchDir('remote-dying-session');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  const bins = { claude: native.bin };
  const cli = cliAccounts({ stateDir, bins, env: { HOME: home, PATH: '/unused', LOGIN_MODE: 'paste' }, managedFolders: { claude: folder } });
  const host = remoteCliHost({ cli, bins, waitCapMs: 60_000 });
  try {
    const first = await host.start('claude'); assert.equal(first.ok, true);
    if (!first.ok) return;
    const dying = host.cancel(first.signIn.id);
    const during = await host.start('claude');
    assert.equal(during.ok ? 'ok' : during.error, 'busy');
    await dying;
    const next = await host.start('claude'); assert.equal(next.ok, true);
  } finally { await host.close(); }
});

test('a native login that exits 0 with no phone waiter is settled before its lock frees', { timeout: 10_000 }, async () => {
  const root = scratchDir('remote-unwaited-success');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  const bins = { claude: native.bin };
  const cli = cliAccounts({ stateDir, bins, env: { HOME: home, PATH: '/unused', LOGIN_MODE: 'success' }, managedFolders: { claude: folder } });
  const host = remoteCliHost({ cli, bins, waitCapMs: 60_000 });
  try {
    const started = await host.start('claude'); assert.equal(started.ok, true);
    const { lock } = signInLock(folder);
    assert.ok(existsSync(lock));
    for (let i = 0; existsSync(lock) && i < 500; i++) await delay(10);
    assert.equal(existsSync(lock), false, 'the lock frees once the native login has settled');
    assert.ok(existsSync(join(folder, '.byokit-signin-complete')), 'the exit-0 login wrote its completion marker with no wait');
    assert.equal((await cli.list())[0]?.state, 'ready');
    const again = await host.start('claude');
    assert.equal(again.ok ? 'ok' : again.error, 'already', 'a settled login is not reused as a signing row');
    assert.equal(native.calls().filter((c) => c.argv[1] === 'login').length, 1, 'no second native login spawned into the same folder');
  } finally { await host.close(); }
});

test('a ready reused row wins over phone cancel during settlement', { timeout: 15_000 }, async () => {
  const root = scratchDir('remote-ready-cancel');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime');
  const home = join(stateDir, 'home'); mkdirSync(home, { recursive: true });
  const folder = join(stateDir, 'claude');
  const bins = { claude: native.bin };
  const statusWait = join(root, 'status-wait');
  const options = { stateDir, bins, env: { HOME: home, PATH: '/unused', STATUS_WAIT_FILE: statusWait }, managedFolders: { claude: folder } };
  const row = (await cliAccounts(options).add('claude')).account;
  const cli = cliAccounts(options);
  const host = remoteCliHost({ cli, bins });
  try {
    const started = await host.start('claude'); assert.ok(started.ok);
    if (!started.ok) return;
    assert.equal(started.signIn.id, row.id, 'restart reuses the pending row');
    for (let i = 0; !existsSync(statusWait) && i < 300; i++) await delay(10);
    assert.ok(existsSync(statusWait), 'exit-0 settlement is reading native status');
    const cancelling = host.cancel(row.id);
    writeFileSync(statusWait + '.release', '');
    const result = await host.wait(row.id);
    await cancelling;
    assert.deepEqual(result, { ok: true, provider: 'claude' }, 'ready settlement wins over phone cancel');
    assert.equal((await cli.status(row.id)).state, 'ready');
    assert.ok(existsSync(join(folder, '.byokit-signin-complete')));
  } finally { writeFileSync(statusWait + '.release', ''); await host.close(); }
});

test('a stalled settlement keeps its holder and lock until the settled row releases them', { timeout: 15_000 }, async () => {
  const root = scratchDir('remote-stalled-settlement');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  const bins = { claude: native.bin };
  const statusWait = join(root, 'status-wait');
  const env = { HOME: home, PATH: '/unused', LOGIN_MODE: 'success', STATUS_WAIT_FILE: statusWait };
  const cli = cliAccounts({ stateDir, bins, env, managedFolders: { claude: folder } });
  const host = remoteCliHost({ cli, bins, waitCapMs: 60_000 });
  const { lock, holder } = signInLock(folder);
  try {
    assert.equal((await host.start('claude')).ok, true);
    assert.equal(Number(readFileSync(holder, 'utf8')), process.pid, 'HOST PID owns the lock from claim, before child exit');
    chmodSync(holder, 0o400); // Any child-exit rewrite would fail: the original owner must remain live.
    for (let i = 0; !existsSync(statusWait) && i < 500; i++) await delay(10);
    assert.ok(existsSync(statusWait), 'the exit-0 settlement is stalled in the native status read');
    assert.ok(existsSync(lock));
    assert.equal(Number(readFileSync(holder, 'utf8')), process.pid, 'the live host holds the lock through settlement');
    const again = await host.start('claude');
    assert.equal(again.ok ? 'ok' : again.error, 'busy', 'the live host refuses a second start');
    assert.equal(native.calls().filter((c) => c.argv[1] === 'login').length, 1, 'no second native login is spawned');
    writeFileSync(`${statusWait}.release`, '');
    for (let i = 0; existsSync(lock) && i < 500; i++) await delay(10);
    assert.equal(existsSync(lock), false, 'the lock frees once settlement finishes');
    assert.equal(existsSync(holder), false, 'the holder is removed with the lock, after settlement');
    assert.equal((await cli.list())[0]?.state, 'ready');
  } finally {
    writeFileSync(`${statusWait}.release`, '');
    await host.close();
  }
});

test('a managed folder that is the default Claude login is refused at construction', () => {
  const root = scratchDir('remote-managed-default-login');
  const native = fakeClaude(join(root, 'bins'));
  const home = join(root, 'home'); mkdirSync(home);
  assert.throws(() => cliAccounts({ stateDir: home, bins: { claude: native.bin }, env: { HOME: home, PATH: '/unused' },
    managedFolders: { claude: join(home, '.claude') } }), { code: 'bad-option' });
});

test('an undefined managed folder entry is treated as absent', async () => {
  const root = scratchDir('remote-managed-undefined');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const cli = cliAccounts({ stateDir, bins: { claude: native.bin }, env: { HOME: home, PATH: '/unused' }, managedFolders: { claude: undefined } });
  const added = await cli.add('claude');
  assert.ok(cli.folderOf(added.account.id).startsWith(join(stateDir, 'claude') + '/'));
});

test('a runtime-owned Codex folder receives the ChatGPT sign-in the engine reads', async () => {
  const root = scratchDir('remote-managed-codex');
  const codex = fakeCodex(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'codex-home'); mkdirSync(folder);
  const bins = { codex: codex.bin };
  const cli = cliAccounts({ stateDir, bins, env: { HOME: home, PATH: '/unused' }, managedFolders: { codex: folder } });
  const host = remoteCliHost({ cli, bins });
  const started = await host.start('codex');
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(cli.launchEnv(started.signIn.id).set.CODEX_HOME, folder);
  assert.deepEqual(await host.wait(started.signIn.id), { ok: true, provider: 'codex' });
  assert.ok(existsSync(join(folder, 'granted')), 'the ChatGPT login lands in the runtime-owned folder');
  assert.equal(cli.folderOf(started.signIn.id), folder);
  writeFileSync(join(folder, 'auth.json'), '{}');
  await cli.remove(started.signIn.id);
  assert.ok(!existsSync(join(folder, 'auth.json')), 'remove deletes the Codex login file');
  assert.ok(existsSync(folder), 'remove keeps the runtime-owned folder');
  await host.close();
});

test('a managed Codex folder that is the default Codex login is refused at construction', () => {
  const root = scratchDir('remote-managed-codex-default');
  const native = fakeCodex(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  assert.throws(() => cliAccounts({ stateDir, bins: { codex: native.bin }, env: { HOME: home, PATH: '/unused' },
    managedFolders: { codex: join(home, '.codex') } }), { code: 'bad-option' });
});

test('a paste into a native child that already closed its stdin fails plainly and cannot crash the host', { timeout: 10_000 }, async () => {
  const root = scratchDir('remote-stdin-closed');
  const bin = join(root, 'bin'); mkdirSync(bin);
  const closed = join(root, 'stdin-closed');
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
console.log('If the browser did not open, visit: https://claude.example.test/authorize');
fs.closeSync(0);
fs.writeFileSync(${JSON.stringify(closed)}, '');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const { host } = kitAndHost(root, { claude: join(bin, 'claude') });
  try {
    const started = await host.start('claude');
    assert.ok(started.ok);
    for (let i = 0; !existsSync(closed) && i < 300; i++) await delay(10);
    let problem: unknown;
    for (let i = 0; i < 300 && problem === undefined; i++) {
      await host.paste(started.signIn.id, 'late-code').catch((error: { remoteCliProblem?: unknown }) => { problem = error.remoteCliProblem ?? 'other'; });
      await delay(10);
    }
    assert.equal(problem, 'failed', 'the broken pipe is a plain failed paste, not an uncaught stream error');
    await host.cancel(started.signIn.id);
  } finally { await host.close(); }
});

test('a login that prints no code fails to start without a row', async () => {
  const root = scratchDir('remote-silent');
  const codex = fakeCodex(join(root, 'bins'));
  const { cli, device, seen } = kitAndHost(root, { codex: codex.bin }, { LOGIN_MODE: 'silent' });
  const started = await device.start('codex');
  assert.equal(started.ok, false);
  if (started.ok) return;
  assert.equal(started.error, 'failed');
  assert.deepEqual(await cli.list(), []);
  repliesClean(seen);
});

test('a managed folder with history signs in again after a cancel', async () => {
  const root = scratchDir('remote-managed-history-again');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  const history = join(root, 'history'); mkdirSync(history);
  const cli = cliAccounts({ stateDir, bins: { claude: native.bin }, env: { HOME: home, PATH: '/unused' }, managedFolders: { claude: folder }, historyFrom: { claude: history } });
  const first = await cli.add('claude');
  assert.equal((await cli.cancel(first.account.id)).removed, true);
  const again = await cli.add('claude');
  assert.equal(again.account.state, 'signing');
  assert.equal(readlinkSync(join(folder, 'projects')), history);
});

test('a login that exits 0 before printing a URL reports already signed in',{ timeout: 10_000 }, async () => {
  const root = scratchDir('remote-silent-success');
  const bins = join(root, 'bins'); mkdirSync(bins, { recursive: true });
  const bin = join(bins, 'claude-silent');
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  const granted = join(folder, 'granted');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'auth' && process.argv[3] === 'login') fs.writeFileSync(${JSON.stringify(granted)}, '');
if (process.argv[2] === 'auth' && process.argv[3] === 'status') console.log(JSON.stringify(fs.existsSync(${JSON.stringify(granted)}) ? { loggedIn: true, email: ${JSON.stringify(EMAIL)} } : { loggedIn: false }));
`, { mode: 0o755 });
  const cli = cliAccounts({ stateDir, bins: { claude: bin }, env: { HOME: home, PATH: '/unused' }, managedFolders: { claude: folder } });
  const host = remoteCliHost({ cli, bins: { claude: bin }, waitCapMs: 60_000 });
  try {
    const started = await host.start('claude');
    assert.equal(started.ok ? 'ok' : started.error, 'already', 'the settled login is reported as signed in');
    assert.equal((await cli.list())[0]?.state, 'ready');
    assert.ok(existsSync(join(folder, '.byokit-signin-complete')));
  } finally { await host.close(); }
});

test('removing a managed account during its sign-in is refused busy and keeps its login', { timeout: 10_000 }, async () => {
  const root = scratchDir('remote-remove-during-signin');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  const bins = { claude: native.bin };
  const cli = cliAccounts({ stateDir, bins, env: { HOME: home, PATH: '/unused', LOGIN_MODE: 'paste', EXPECT_CODE: 'unused' }, managedFolders: { claude: folder } });
  const host = remoteCliHost({ cli, bins, waitCapMs: 60_000 });
  try {
    const started = await host.start('claude');
    assert.equal(started.ok, true);
    const id = started.ok ? started.signIn.id : '';
    writeFileSync(join(folder, '.credentials.json'), '{}');
    await assert.rejects(cli.remove(id), { code: 'prepare-failed' });
    assert.equal(existsSync(join(folder, '.credentials.json')), true, 'the in-flight login is not deleted');
    assert.equal((await cli.list()).length, 1, 'the row is still there');
  } finally { await host.close(); }
});

test('removing a managed Claude account deletes its login files and keeps the folder', async () => {
  const root = scratchDir('remote-managed-remove-login');
  const native = fakeClaude(join(root, 'bins'));
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  const cli = cliAccounts({ stateDir, bins: { claude: native.bin }, env: { HOME: home, PATH: '/unused' }, managedFolders: { claude: folder } });
  const added = await cli.add('claude');
  writeFileSync(join(folder, '.credentials.json'), '{}');
  writeFileSync(join(folder, '.claude.json'), '{}');
  await cli.remove(added.account.id);
  assert.equal(existsSync(join(folder, '.credentials.json')), false);
  assert.equal(existsSync(join(folder, '.claude.json')), false);
  assert.equal(existsSync(folder), true);
  assert.deepEqual(await cli.list(), []);
});

test('a login whose status does not confirm keeps its login files', { timeout: 10_000 }, async () => {
  const root = scratchDir('remote-unconfirmed-keeps-login');
  const bins = join(root, 'bins'); mkdirSync(bins, { recursive: true });
  const bin = join(bins, 'claude-unconfirmed');
  const stateDir = join(root, 'runtime'); mkdirSync(stateDir);
  const home = join(stateDir, 'home'); mkdirSync(home);
  const folder = join(stateDir, 'claude');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'auth' && process.argv[3] === 'login') fs.writeFileSync(${JSON.stringify(join(folder, '.credentials.json'))}, '{}');
if (process.argv[2] === 'auth' && process.argv[3] === 'status') console.log(JSON.stringify({ loggedIn: false }));
`, { mode: 0o755 });
  const cli = cliAccounts({ stateDir, bins: { claude: bin }, env: { HOME: home, PATH: '/unused' }, managedFolders: { claude: folder } });
  const host = remoteCliHost({ cli, bins: { claude: bin }, waitCapMs: 60_000 });
  try {
    const started = await host.start('claude');
    assert.equal(started.ok ? 'ok' : started.error, 'failed');
    assert.equal(existsSync(join(folder, '.credentials.json')), true, 'the unconfirmed login is not destroyed');
    assert.deepEqual(await cli.list(), []);
  } finally { await host.close(); }
});
