// Remote agent-CLI sign-in over a paired link: fake native CLIs stand in for Codex's device-code
// login and Claude's link-and-paste-code login; a thin stub link carries the same op/args/reply
// contract `@byokit/pair` seals on the wire. No account, no network, no real credential anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAccounts, remoteCliHost } from '../src/cli.ts';
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
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
  const mode = process.env.LOGIN_MODE || 'success';
  if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
    const on = granted && fs.existsSync(granted);
    console.log(JSON.stringify(on
      ? { loggedIn: true, email: ${JSON.stringify(EMAIL)}, planType: 'plus', subscriptionType: 'pro', access_token: ${JSON.stringify(TOKEN)} }
      : { loggedIn: false }));
    return;
  }
  if (process.argv[2] === 'auth' && process.argv[3] === 'login') {
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

function kitAndHost(root: string, bins: Partial<Record<RemoteCliProvider, string>>, extraEnv: Record<string, string> = {}) {
  const stateDir = join(root, 'plans');
  mkdirSync(stateDir, { recursive: true });
  const env = { HOME: join(root, 'home'), PATH: '/unused', ...extraEnv };
  const cli = cliAccounts({ stateDir, bins, env });
  const host = remoteCliHost({ cli, bins });
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
  ]);
  // Nothing written: no roster, no markers; only status reads ran.
  assert.deepEqual(readdirSync(stateDir), []);
  assert.ok(codex.calls().every((c) => c.argv[0] === 'app-server'));
  assert.ok(claude.calls().every((c) => c.argv.join(' ') === 'auth status'));
  assert.ok(pi.calls().every((c) => c.argv.includes('--no-refresh')), 'Pi status never refreshes');
  repliesClean(seen);
  // After each CLI's own login, state names the account without secrets.
  const logins = await cli.add('pi', { piProvider: 'openai-codex' });
  writeFileSync(logins.signIn.completion, 'complete', { mode: 0o600 });
  for (const bin of [codex, claude]) {
    const { account, signIn } = bin === codex ? await cli.add('codex') : await cli.add('claude');
    const folder = Object.values(cli.launchEnv(account.id).set)[0];
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
