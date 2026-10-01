// The isolation guarantee, shown three ways around one real run (isolated-run.ts): a decoy HOME holding someone's Pi,
// Codex and Claude sign-ins plus the environment a shell inside their Pi hands down; an fs tracer; and Node's
// permission model, so the operating system itself refuses any read outside the kit and the app's own folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import fs from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { join, resolve } from 'node:path';
import { decoy, traceFs } from '../src/testing/index.ts';

test("a sign-in, a stored sign-in and its status never touch anyone else's AI setup", () => {
  const d = decoy(scratchDir('decoy'));
  const app = join(d.root, 'app');
  mkdirSync(app);
  const repo = resolve(import.meta.dirname, '..', '..', '..');
  const allow = ['--permission', `--allow-fs-read=${repo}`, `--allow-fs-read=${app}`, `--allow-fs-write=${app}`, `--allow-fs-write=${d.env.TRACE_LOG}`];
  const node = (...args: string[]) => spawnSync(process.execPath, [...allow, ...args], { env: { PATH: process.env.PATH, ...d.env, APP_DIR: app }, encoding: 'utf8', timeout: 20_000 });
  // Control: under these flags, reading the decoy is refused outright.
  const control = node('--input-type=module', '-e', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(d.home, '.pi', 'agent', 'auth.json'))});`);
  assert.match(control.stderr, /ERR_ACCESS_DENIED/);
  const r = node('--import', traceFs, join(import.meta.dirname, 'isolated-run.ts'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.deepEqual([out.code, out.url], ['MOCK-12345', 'https://auth.openai.com/codex/device'], 'the real ChatGPT sign-in reached its code');
  assert.deepEqual([out.cancelled, out.ready, out.openrouter, out.other], [false, true, false, false]);
  assert.equal(out.words, 'ChatGPT is connected.');
  assert.deepEqual(out.env, ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY']);
  assert.ok(out.asked.every((u: string) => u.startsWith('auth.openai.com/api/accounts/deviceauth/')), out.asked.join(', '));

  assert.equal(d.touched(), '', 'the tracer saw a touch');
  assert.deepEqual(d.changed(), [], 'byte for byte, and not even rewritten');
  assert.deepEqual(d.ran(), []);
  assert.deepEqual(d.leaks(app), [], 'a key or sign-in from the decoy reached the app\'s folder');
});

test('managed CLI accounts never touch default logins or inherit ambient keys', () => {
  const root = scratchDir('cli-isolation'); const d = decoy(root);
  const app = join(root, 'app'); mkdirSync(app);
  const bins = join(app, 'bins'); mkdirSync(bins);
  const log = join(app, 'calls.jsonl');
  const canary = 'canary-byokit-7f3a9c';
  const bin = join(bins, 'claude');
  fs.writeFileSync(log, '');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),env:process.env})+'\\n');
console.log(JSON.stringify({loggedIn:true,email:'isolated@example.test',subscriptionType:'pro',access_token:${JSON.stringify(canary)}}));
`, { mode: 0o755 });
  const history = join(d.home, '.claude', 'projects');
  // A missing history target stays missing; add only links to it.
  const stateDir = join(app, 'plans');
  const module = new URL('../src/cli.ts', import.meta.url).href;
  const passed = { HOME: d.home, PATH: '/unused', ONLY_PASSED: 'yes' };
  const r = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', `
    const {cliAccounts} = await import(${JSON.stringify(module)});
    const kit = cliAccounts(${JSON.stringify({ stateDir, bins: { claude: bin }, env: passed, historyFrom: { claude: history } })});
    const {account,signIn} = await kit.add('claude');
    const before = await kit.status(account.id);
    const {spawnSync}=await import('node:child_process');
    const login=spawnSync('/bin/sh',['-c',signIn.shell],{env:process.env,encoding:'utf8'});
    if(login.status!==0) throw new Error('fake login failed');
    const after=await kit.status(account.id);
    await kit.rename(account.id,'Isolated'); kit.acknowledgeTerms(); await kit.list();
    await kit.remove(account.id);
    console.log(JSON.stringify({before,after}));
  `], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...d.env } });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout + r.stderr, new RegExp(canary));
  const result = JSON.parse(r.stdout); assert.equal(result.before.state, 'signing'); assert.equal(result.after.state, 'ready');
  const touches = d.touched().split('\n').filter(Boolean);
  assert.deepEqual(touches, [history], 'the sole default-folder touch names the symlink target without accessing it');
  assert.equal(fs.existsSync(history), false);
  assert.deepEqual(d.changed(), []); assert.deepEqual(d.ran(), []); assert.deepEqual(d.leaks(stateDir), []);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.env).sort(), ['CLAUDE_CONFIG_DIR', ...Object.keys(passed)].sort());
    for (const [key, value] of Object.entries(passed)) assert.equal(call.env[key], value);
    assert.ok(call.env.CLAUDE_CONFIG_DIR.startsWith(stateDir + '/claude/'));
    assert.doesNotMatch(JSON.stringify(call), new RegExp(canary));
  }
});
