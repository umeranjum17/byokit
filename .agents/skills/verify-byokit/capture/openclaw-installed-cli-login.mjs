// Built public API + real pinned Gateway. The person's HOME is a task-owned stand-in home under the scratch root;
// `claude` and `codex` on the engine PATH are offline stand-ins that record the HOME, CLAUDE_CONFIG_DIR and CODEX_HOME
// each call receives. Their "login" is a marker file, never a credential. No provider, account or spend.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit, ENGINE_VERSION } from '@byokit/openclaw';

const root = process.argv[2], expectFix = process.argv.includes('--expect-fix');
if (!root || !root.startsWith('/') || root === '/') throw new Error('Pass an absolute task-private scratch root');
const person = process.env.HOME;
if (!person || !person.startsWith(`${root}/`)) throw new Error('Run with HOME set to a stand-in home inside the scratch root, never a real home');
mkdirSync(person, { recursive: true });
const stateDir = mkdtempSync(join(root, 'state-')), bin = join(stateDir, 'bin'), calls = join(stateDir, 'calls.jsonl');
const login = join(person, '.claude', 'stand-in-login'), folder = join(stateDir, 'openclaw', 'home', '.claude');
const codexHome = join(stateDir, 'openclaw/home/.codex'), codexLogin = join(person, '.codex/auth.json');
const codexMarker = join(person, 'codex-signed-in');
mkdirSync(join(person, '.codex'), { recursive: true });
writeFileSync(codexLogin, 'SYNTHETIC-CODEX-CANARY-MUST-NOT-BE-READ');
utimesSync(codexLogin, new Date(0), new Date(0));
const canaryBefore = statSync(codexLogin, { bigint: true });
mkdirSync(bin); mkdirSync(join(person, '.claude'), { recursive: true });
// Keep the extensionless CLIs' require() valid when the scratch root inherits this repo's ESM package.
writeFileSync(join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
const record = (who) => `const fs=require('node:fs'),path=require('node:path'),argv=process.argv.slice(2),{HOME,CLAUDE_CONFIG_DIR,CODEX_HOME}=process.env;
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({who:${JSON.stringify(who)},argv:argv.join(' ').slice(0,40),HOME,CLAUDE_CONFIG_DIR,CODEX_HOME})+'\\n');`;
writeFileSync(join(bin, 'claude'), `#!${process.execPath}
${record('claude')}
const marker=path.join(CLAUDE_CONFIG_DIR||path.join(HOME,'.claude'),'stand-in-login'),loggedIn=fs.existsSync(marker);
const args=argv.join(' ');
if(args==='--version') console.log('2.1.0 (Claude Code)');
else if(args.startsWith('auth status')) { console.log(args.endsWith('--text')?(loggedIn?'Login method: Claude Max Account':'Not logged in'):JSON.stringify({loggedIn,authMethod:'claude.ai',subscriptionType:'max'})); if(!loggedIn) process.exit(1); }
else if(args==='auth login --claudeai') { console.log('If the browser did not open, visit: https://claude.example.test/authorize'); process.stdin.once('data',()=>process.exit(1)); }
else {
 if(!loggedIn) { console.error('401 Unauthorized: not signed in'); process.exit(1); }
 const emit=value=>console.log(JSON.stringify(value));
 emit({type:'assistant',message:{id:'stand-in',role:'assistant',content:[{type:'text',text:'Hello Umer'}]}});
 emit({type:'result',subtype:'success',is_error:false,result:'Hello Umer',session_id:'stand-in-session',usage:{input_tokens:11,output_tokens:7}});
}
`, { mode: 0o700 });
writeFileSync(join(bin, 'codex'), `#!${process.execPath}
${record('codex')}
if(argv.join(' ')==='--version') console.log('codex-cli 0.0.0-stand-in');
else if(argv[0]==='login') { const ready=fs.existsSync(${JSON.stringify(codexMarker)}); console.error(ready?'Logged in using ChatGPT':'Not logged in'); process.exit(ready?0:1); }
else if(argv[0]==='exec') {
 process.stdin.resume(); process.stdin.on('end',()=>{
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Hello Umer from Luna'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:5}}));
 });
} else process.exit(2);
`, { mode: 0o700 });

const gatewayEnv = () => {
  const pid = readFileSync(join(stateDir, 'openclaw', 'gateway.pid'), 'utf8').trim();
  const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return { HOME: env.HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: env.CODEX_HOME, OPENCLAW_HOME: env.OPENCLAW_HOME };
};
const seen = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const kitFor = () => new OpenClawKit({ stateDir, engineDir: process.env.BYOKIT_TEST_ENGINE_DIR ?? join(root, 'engine'), enginePath: [bin],
  config: { agents: { defaults: { modelPolicy: { allow: ['claude-cli/*', 'openai-codex/*'] } } } } });
const show = (value) => console.log(JSON.stringify(value));
show({ proof: 'real pinned Gateway, offline claude/codex stand-ins', version: ENGINE_VERSION, personHome: person, engineRoot: join(stateDir, 'openclaw') });

let kit;
try {
  // Leg 1: the person's installed Claude Code is signed in. No sign-in step: signedIn and a run work at once.
  writeFileSync(login, 'signed in');
  kit = kitFor();
  await kit.start();
  assert.equal(kit.state.phase, 'ready');
  const installed = gatewayEnv(), signedIn = await kit.signedIn('umer', 'claude-cli');
  // The kit's account listing, as Crewhouse reads it: the installed login is an account whose Claude CLI models are available.
  const claudeAccount = (await kit.accounts('umer')).find((row) => row.provider === 'claude-cli');
  const claudeModels = claudeAccount ? (await kit.models('umer', claudeAccount.id)).filter((m) => m.id.startsWith('claude-cli/') && m.available) : [];
  const end = await kit.run({ member: 'umer', sessionKey: 'agent:umer:installed', message: 'Say hello to Umer', model: 'claude-cli/claude-sonnet-5' }, () => {});
  show({ leg: 'installed login signed in', gatewayEnv: installed, signedInClaudeCli: signedIn, account: claudeAccount ? { id: claudeAccount.id, state: claudeAccount.state, models: claudeModels.length } : null, run: end.ok ? { ok: true, text: end.text } : end });
  show({ leg: 'installed login signed in', cliCalls: seen() });
  if (expectFix) {
    assert.deepEqual([installed.HOME, installed.CLAUDE_CONFIG_DIR, installed.CODEX_HOME], [person, undefined, codexHome]);
    for (const call of seen()) {
      assert.equal(call.HOME, person);
      assert.equal(call.CLAUDE_CONFIG_DIR, undefined);
      if (call.who === 'codex') assert.ok(call.CODEX_HOME === undefined || call.CODEX_HOME === codexHome);
    }
    assert.ok(signedIn && end.ok && end.text === 'Hello Umer', JSON.stringify(end));
    assert.ok(claudeAccount && claudeAccount.state === 'ready' && claudeModels.length > 0, JSON.stringify({ claudeAccount, claudeModels }));
  }
  // Leg 2: the engine calls a Codex process, without reading the throwaway person's canary login.
  writeFileSync(codexMarker, 'signed in');
  const luna = await kit.run({ member: 'umer', sessionKey: 'agent:umer:installed-luna',
    message: 'Say hello to Umer', model: 'openai-codex/gpt-6-luna' });
  assert.ok(luna.ok && luna.text === 'Hello Umer from Luna', JSON.stringify(luna));
  const codexCalls = seen().filter(call => call.who === 'codex');
  assert.ok(codexCalls.some(call => call.argv.startsWith('exec ')));
  assert.ok(codexCalls.every(call => call.HOME === person));
  assert.ok(codexCalls.filter(call => call.argv.startsWith('exec ')).every(call => call.CODEX_HOME === undefined));
  assert.ok(codexCalls.filter(call => call.CODEX_HOME !== undefined).every(call =>
    call.CODEX_HOME === codexHome && (call.argv === '--version' || call.argv === 'login status')));
  rmSync(codexMarker);
  assert.equal(await kit.signedIn('umer', 'openai-codex'), false);
  const unsigned = await kit.run({ member: 'umer', sessionKey: 'agent:umer:unsigned-luna',
    message: 'hello', model: 'openai-codex/gpt-6-luna' });
  assert.ok(!unsigned.ok && unsigned.kind === 'signed-out', JSON.stringify(unsigned));
  show({ leg: 'installed Codex stand-in', run: luna, unsigned, cliCalls: codexCalls });
  await kit.stop(); kit = undefined;

  // Leg 3: no installed sign-in. The engine falls back to its own folder and the phone sign-in is still offered.
  rmSync(login);
  writeFileSync(calls, '');
  kit = kitFor();
  await kit.start();
  const fallback = gatewayEnv();
  let shown;
  const drive = kit.signIn('umer', { authChoice: 'anthropic-cli' }, view => { if (view.url) shown = view; });
  for (let i = 0; !shown && i < 300; i++) await delay(100);
  drive.cancel();
  const settled = await drive.done;
  show({ leg: 'no installed login', gatewayEnv: fallback, fallbackOffered: shown ? { url: shown.url, prompt: shown.prompt } : null, afterCancel: { state: settled.state, why: settled.why } });
  show({ leg: 'no installed login', cliCalls: seen() });
  if (expectFix) {
    assert.deepEqual([fallback.HOME, fallback.CLAUDE_CONFIG_DIR, fallback.CODEX_HOME], [person, folder, codexHome]);
    assert.equal(shown?.url, 'https://claude.example.test/authorize');
  }
  const canaryAfter = statSync(codexLogin, { bigint: true });
  assert.equal(canaryAfter.atimeNs, canaryBefore.atimeNs, 'synthetic login was not read');
  assert.equal(canaryAfter.mtimeNs, canaryBefore.mtimeNs, 'synthetic login was not changed');
  show({ canaryLoginUnreadAndUnchanged: true, liveSubscription: 'not performed by this offline recipe',
    result: expectFix ? 'PASS' : 'printed (no --expect-fix)' });
} finally { await kit?.stop(); rmSync(stateDir, { recursive: true, force: true }); }
