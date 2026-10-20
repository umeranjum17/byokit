// Built public API + pinned Gateway; the task-owned Claude CLI is an offline protocol stand-in, never a login.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit, ENGINE_VERSION } from '@byokit/openclaw';
const root = process.argv[2];
if (!root || !root.startsWith('/') || root === '/') throw new Error('Pass an absolute task-private scratch root');
mkdirSync(root, { recursive: true });
const stateDir = mkdtempSync(join(root, 'state-'));
const bin = join(stateDir, 'bin');
const home = join(stateDir, 'openclaw/home/.claude');
mkdirSync(bin); mkdirSync(home, { recursive: true });
// Keep the extensionless CLI's require() valid when the scratch root inherits this repo's ESM package.
writeFileSync(join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
writeFileSync(join(home, '.credentials.json'), 'synthetic signed-in');
const countFile = join(stateDir, 'auth-count'), executions = join(stateDir, 'executions');
writeFileSync(countFile, ''); writeFileSync(executions, '');
writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const {readFileSync,appendFileSync}=require('node:fs');
const args=process.argv.slice(2).join(' ');
if(args==='--version') console.log('2.1.0 (Claude Code)');
else if(args.startsWith('auth status')) {
 appendFileSync(${JSON.stringify(countFile)},'auth\\n');
 const loggedIn=readFileSync(process.env.CLAUDE_CONFIG_DIR+'/.credentials.json','utf8')==='synthetic signed-in';
 console.log(args.endsWith('--json')?JSON.stringify({loggedIn,authMethod:'claude.ai',subscriptionType:'max'}):(loggedIn?'Login method: Claude Max Account':'Not logged in'));
 if(!loggedIn) process.exit(1); // setup.detect interprets the status command's exit, not JSON loggedIn
} else {
 appendFileSync(${JSON.stringify(executions)},'run\\n');
 if(readFileSync(process.env.CLAUDE_CONFIG_DIR+'/.credentials.json','utf8')!=='synthetic signed-in') {
  console.error('401 Unauthorized: your sign-in has expired'); process.exit(1);
 }
 const emit=value=>console.log(JSON.stringify(value));
 emit({type:'stream_event',event:{type:'message_start',message:{id:'synthetic-message'}}});
 emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}});
 emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'',estimated_tokens:23}}});
 emit({type:'stream_event',event:{type:'content_block_stop',index:0}});
 emit({type:'assistant',message:{id:'synthetic-message',role:'assistant',content:[{type:'text',text:'Hello Umer'}]}});
 emit({type:'result',subtype:'success',is_error:false,result:'Hello Umer',session_id:'synthetic-session',usage:{input_tokens:11,output_tokens:7}});
}
`, { mode: 0o700 });
const kit = new OpenClawKit({ stateDir, engineDir: join(root, 'engine'), enginePath: [bin],
  config: { agents: { defaults: { modelPolicy: { allow: ['claude-cli/*'] } } } } });
const counts = () => readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean).length;
let off;
try {
  await kit.start();
  assert.equal(kit.state.phase, 'ready');
  assert.equal(kit.hello.server.version, ENGINE_VERSION);
  console.log(JSON.stringify({ proof: 'real pinned Gateway, offline native CLI stand-in', version: ENGINE_VERSION }));
  assert.ok(await kit.signedIn('umer', 'claude-cli'));
  for (const warmth of ['prepared', 'warm']) {
    const start = performance.now(), events = [], raw = [];
    off = kit.onEvent('agent', payload => {
      if (payload.stream === 'thinking') { raw.push(payload.data); console.log(JSON.stringify({ warmth, rawThinking: payload.data, ms: Math.round(performance.now() - start) })); }
    });
    console.log(JSON.stringify({ warmth, action: 'send', at: new Date().toISOString(), nativeAuthChecks: counts() }));
    const before = counts();
    const end = await kit.run({ member: 'umer', sessionKey: `agent:umer:${warmth}`, message: 'Say hello to Umer', model: 'claude-cli/claude-sonnet-5' }, e => {
      events.push(e); console.log(JSON.stringify({ warmth, ms: Math.round(performance.now() - start), event: e, nativeAuthChecks: counts() }));
    });
    off(); off = undefined;
    console.log(JSON.stringify({ warmth, answerMs: Math.round(performance.now() - start), end, nativeAuthChecks: counts(), addedNativeChecks: counts() - before }));
    assert.ok(end.ok && end.text === 'Hello Umer', JSON.stringify(end));
    assert.ok(raw.some(d => d.progressTokens === 23), 'real engine must produce actual native progressTokens');
    if (process.argv.includes('--expect-progress')) {
      assert.deepEqual(events[0], { type: 'started' });
      assert.equal(events.filter(e => e.type === 'started').length, 1);
      assert.ok(events.some(e => e.type === 'thinking' && e.tokens === 23));
      assert.equal(counts(), before, 'prepared native admission must avoid another CLI status probe');
    }
  }
  writeFileSync(join(home, '.credentials.json'), 'synthetic signed-out');
  const detected = await kit.call('openclaw.setup.detect', { agentId: 'umer' });
  const native = detected.candidates?.find(c => c.kind === 'claude-cli');
  console.log(JSON.stringify({ changedAccountDetection: native }));
  assert.equal(native?.credentials, false, 'signed-out status must actually reach admission');
  const beforeExecution = readFileSync(executions, 'utf8');
  const events = [];
  const end = await kit.run({ member: 'umer', sessionKey: 'agent:umer:missing', message: 'hello', model: 'claude-cli/claude-sonnet-5' }, e => events.push(e));
  console.log(JSON.stringify({ changedAccount: true, end, events, nativeAuthChecks: counts() }));
  assert.ok(!end.ok && end.kind === 'signed-out');
  assert.deepEqual(events, []);
  assert.equal(readFileSync(executions, 'utf8'), beforeExecution, 'kit must reject before native execution');
} finally { off?.(); await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
