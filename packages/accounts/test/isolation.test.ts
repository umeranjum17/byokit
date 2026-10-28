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
import { CANARY, decoy, traceFs } from '../src/testing/index.ts';

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
  assert.equal(out.unchanged, true);
  assert.deepEqual(out.env, ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY']);
  assert.ok(out.asked.every((u: string) => u.startsWith('auth.openai.com/api/accounts/deviceauth/')), out.asked.join(', '));

  assert.equal(d.touched(), '', 'the tracer saw a touch');
  assert.deepEqual(d.changed(), [], 'byte for byte, and not even rewritten');
  assert.deepEqual(d.ran(), []);
  assert.deepEqual(d.leaks(app), [], 'a key or sign-in from the decoy reached the app\'s folder');
});

test('managed Pi and found-row adoption never read grants, discovered sources or default logins', () => {
  const root = scratchDir('pi-isolation'); const d = decoy(root); const app = join(root, 'app'); mkdirSync(app);
  const stateDir = join(app, 'plans'); mkdirSync(stateDir);
  const log = join(app, 'calls.jsonl'); const bin = join(app, 'pi'); const canary = 'private-pi-canary';
  fs.writeFileSync(log, '');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),env:process.env})+'\\n');
if(process.argv[2]==='auth') console.log(JSON.stringify({status:'ready',provider:'openai-codex',authType:'oauth',access_token:${JSON.stringify(canary)}}));
`, { mode: 0o755 });
  const found = { id: 'found-pi', provider: 'pi', name: 'Found', folder: join(d.home, '.pi', 'agent'), found: true };
  fs.writeFileSync(join(stateDir, 'accounts-v1.json'), JSON.stringify({ version: 1, accounts: [found] }));
  const passed = { HOME: d.home, PATH: '/unused', PI_CODING_AGENT_DIR: found.folder, PI_CODING_AGENT_SESSION_DIR: found.folder, OPENAI_API_KEY: canary, ANTHROPIC_OAUTH_TOKEN: canary, CLAUDE_CONFIG_DIR: found.folder, CODEX_HOME: found.folder };
  const module = new URL('../src/cli.ts', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', `
    const {cliAccounts}=await import(${JSON.stringify(module)});
    const kit=cliAccounts(${JSON.stringify({ stateDir, bins: { pi: bin }, env: passed })});
    const {account,signIn}=await kit.adopt('found-pi',{piProvider:'openai-codex',model:'chosen-model'});
    const {spawnSync}=await import('node:child_process');
    const login=spawnSync('/bin/sh',['-c',signIn.shell],{env:process.env,encoding:'utf8'});
    if(login.status!==0) throw new Error('fake TUI failed');
    const ready=await kit.status(account.id);
    await kit.rename(account.id,'Owned'); await kit.list();
    await kit.cancel(account.id);
    console.log(JSON.stringify({ready,signIn}));
  `], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...d.env, TRACE_ROOTS: d.env.TRACE_ROOTS + ':' + stateDir } });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout + r.stderr, new RegExp(canary));
  assert.equal(JSON.parse(r.stdout).ready.state, 'ready');
  const touches = d.touched().split('\n').filter(Boolean);
  assert.ok(touches.every(p => p.startsWith(stateDir + '/') || p === stateDir), touches.join('\n'));
  assert.ok(touches.every(p => !/\/(auth|settings|models)\.json$/.test(p)), 'kit never opens Pi credential/settings files');
  assert.deepEqual(d.changed(), []); assert.deepEqual(d.ran(), []); assert.deepEqual(d.leaks(stateDir), []);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls[0].argv, ['--provider', 'openai-codex', '--model', 'chosen-model']);
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.env).sort(), ['HOME', 'PATH', 'PI_CODING_AGENT_DIR']);
    assert.ok(call.env.PI_CODING_AGENT_DIR.startsWith(stateDir + '/pi/'));
    assert.doesNotMatch(JSON.stringify(call), new RegExp(canary));
    if (call.argv[0] === 'auth') assert.deepEqual(call.argv, ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh']);
  }
});

test('installed OpenCode discovery stats its login store and launches without managed folder overrides', () => {
  const root = scratchDir('opencode-installed-isolation'); const d = decoy(root);
  const app = join(root, 'app'); mkdirSync(app);
  const stateDir = join(app, 'plans'), bin = join(app, 'opencode'), calls = join(app, 'calls.jsonl');
  const missingHome = join(app, 'missing-home'), xdgDataHome = join(app, 'xdg-data'); mkdirSync(missingHome);
  const dbStore = join(xdgDataHome, 'opencode', 'opencode.db'); mkdirSync(join(xdgDataHome, 'opencode'), { recursive: true });
  fs.writeFileSync(dbStore, 'fixture-opencode-db');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({argv:process.argv.slice(2),env:process.env})+'\\n');\nconsole.log('fixture OpenCode ran');\n`, { mode: 0o755 });
  const module = new URL('../src/cli.ts', import.meta.url).href;
  const passed = { HOME: d.home, PATH: '/unused', OPENCODE_API_KEY: `${CANARY}-opencode-env`, OPENCODE_CONFIG: '/private/config.json',
    OPENCODE_CONFIG_CONTENT: 'private config canary', OPENCODE_DB: '/private/opencode.db', CLAUDE_CONFIG_DIR: '/private/claude', CODEX_HOME: '/private/codex' };
  const child = `
    const {cliAccounts}=await import(${JSON.stringify(module)});
    const options=${JSON.stringify({ stateDir, bins: { opencode: bin }, env: passed, installed: true })};
    const kit=cliAccounts(options), rows=await kit.list();
    if(rows.map(r=>r.id).join(',')!=='installed-opencode') throw new Error('OpenCode was not listed only for its installed store');
    const row=rows[0];
    if(row.state!=='unknown'||row.why!=='unknown'||row.reason!=='unavailable'||'retryAfterMs' in row||!row.cause.includes('non-secret')) throw new Error('OpenCode status was not honestly unknown');
    const launch=await kit.launch('installed-opencode');
    if(!launch.ok||launch.account.state!=='unknown'||Object.keys(launch.set).length) throw new Error('installed OpenCode launch was not allowed without folder overrides');
    const required=['OPENCODE_API_KEY','OPENCODE_CONFIG','OPENCODE_CONFIG_CONTENT','OPENCODE_DB','CLAUDE_CONFIG_DIR','CODEX_HOME'];
    if(required.some(k=>!launch.unset.includes(k))) throw new Error('launch did not scrub every per-use override');
    if((await import('node:fs')).readFileSync(${JSON.stringify(calls)},'utf8')) throw new Error('status attempted to run OpenCode');
    const childEnv={...options.env,...launch.set}; for(const k of launch.unset) delete childEnv[k];
    const {spawnSync}=await import('node:child_process');
    const run=spawnSync(${JSON.stringify(bin)},['--version'],{encoding:'utf8',env:childEnv});
    if(run.status!==0) throw new Error('the consumer could not run its OpenCode binary');
    const observed=JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(calls)},'utf8'));
    if(observed.argv.join(' ')!=='--version'||observed.env.HOME!==options.env.HOME) throw new Error('launch changed the executable or HOME');
    if(required.some(k=>k in observed.env)) throw new Error('a launch override survived');
    if(['OPENCODE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME'].some(k=>k in observed.env)) throw new Error('BYOKit added a folder or XDG override');
    const missing=cliAccounts({...options,stateDir:${JSON.stringify(join(app, 'missing-store-state'))},env:{HOME:${JSON.stringify(missingHome)},PATH:'/unused'}});
    if((await missing.list()).length) throw new Error('OpenCode was listed without its login store');
    const dbOnly=cliAccounts({...options,stateDir:${JSON.stringify(join(app, 'db-state'))},env:{HOME:${JSON.stringify(missingHome)},PATH:'/unused',XDG_DATA_HOME:${JSON.stringify(xdgDataHome)}}});
    if((await dbOnly.list()).map(r=>r.id).join(',')!=='installed-opencode') throw new Error('OpenCode DB login store was not discovered through XDG_DATA_HOME');
    const noBinary=cliAccounts({...options,stateDir:${JSON.stringify(join(app, 'missing-bin-state'))},bins:{}});
    if((await noBinary.list()).length) throw new Error('OpenCode was listed without its binary');
    console.log(JSON.stringify({id:row.id,state:row.state,reason:row.reason,cause:row.cause,launchOk:launch.ok,set:launch.set,unset:launch.unset,argv:observed.argv,home:observed.env.HOME}));
  `;
  const r = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', child], { encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ...d.env, TRACE_METHODS: '1', TRACE_ROOTS: [...d.roots, app].join(':'), TRACE_LOG: d.env.TRACE_LOG } });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout + r.stderr, /canary-byokit|private config canary/);
  const result = JSON.parse(r.stdout.trim());
  assert.deepEqual([result.id, result.state, result.reason, result.launchOk, result.argv, result.home],
    ['installed-opencode', 'unknown', 'unavailable', true, ['--version'], d.home]);
  assert.deepEqual(result.set, {});
  for (const key of ['OPENCODE_API_KEY', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DB', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) assert.ok(result.unset.includes(key), key);
  const touches = d.touched().split('\n').filter(Boolean).map((line) => JSON.parse(line)) as { method: string; path: string }[];
  const stores = [join(d.home, '.local', 'share', 'opencode', 'auth.json'), dbStore];
  const existenceOnly = new Set(['existsSync', 'statSync', 'lstatSync', 'accessSync', 'stat', 'lstat', 'access']);
  for (const store of stores) {
    const storeTouches = touches.filter((touch) => touch.path === store);
    assert.ok(storeTouches.some((touch) => existenceOnly.has(touch.method)), `${store} was checked for existence`);
    assert.ok(storeTouches.every((touch) => existenceOnly.has(touch.method)), `${store} was only checked for existence`);
  }
  assert.deepEqual(d.changed(), [], 'OpenCode login canaries remain byte-for-byte unchanged');
  assert.deepEqual(d.leaks(app), [], 'no OpenCode login canary reached BYOKit state or launch output');
  assert.deepEqual(d.ran(), []);
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
