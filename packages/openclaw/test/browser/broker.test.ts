import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { get } from 'node:http';
import { WebSocket } from 'ws';
import { launchBroker } from '../../src/browser/broker.ts';

// This executable is a synthetic peer on Chromium's inherited fd3/fd4, not an injectable production transport.
const peer = `#!${process.execPath}
import fs from 'node:fs';
const input = fs.createReadStream('', {fd:3}), output = fs.createWriteStream('', {fd:4});
const targets = new Map([['agent', {targetId:'agent',type:'page',url:'http://127.0.0.1:1/task',title:'Task'}]]);
const sessions = new Map(); let seq=0, buffer='';
const emit = m => output.write(JSON.stringify(m)+'\\0');
const event = (method,params,target) => {
  emit({method,params});
  for(const [sid,t] of sessions) if(t === 'browser' || t === target) emit({method,params,sessionId:sid});
};
input.on('data',data=>{
  buffer+=data; let end;
  while((end=buffer.indexOf('\\0'))!==-1){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);handle(m);}
});
function handle(m){
 const p=m.params??{}, target=p.targetId??sessions.get(m.sessionId);
 const reply=result=>emit({id:m.id,result});
 switch(m.method){
 case 'Browser.getVersion':return reply({product:'fixture',protocolVersion:'1.3',userAgent:'fixture'});
 case 'Target.getTargets':return reply({targetInfos:[...targets.values()]});
 case 'Target.getTargetInfo':return reply({targetInfo:targets.get(target)});
 case 'Target.attachToBrowserTarget':{const sessionId='s'+(++seq);sessions.set(sessionId,'browser');return reply({sessionId});}
 case 'Target.attachToTarget':{const sessionId='s'+(++seq);sessions.set(sessionId,target);return reply({sessionId});}
 case 'Target.detachFromTarget':sessions.delete(p.sessionId);return reply({});
 case 'Target.createTarget':{
  const targetId='private'+(++seq);const info={targetId,type:'page',url:p.url,title:'Blank'};targets.set(targetId,info);
  event('Target.targetCreated',{targetInfo:info});return reply({targetId});}
 case 'Page.navigate':{
  const info=targets.get(target);info.url=p.url;
  event('Page.frameStartedLoading',{frameId:target},target);
  event('Page.frameNavigated',{frame:{id:target,url:p.url}},target);
  event('Network.responseReceived',{type:'Document',frameId:target,response:{status:p.url.includes('401-iframe')?401:200}},target);
  if(p.url.includes('401-iframe'))event('Network.responseReceived',{type:'Document',frameId:target+'child',response:{status:200}},target);
  event('Page.loadEventFired',{},target);
  event('Target.targetInfoChanged',{targetInfo:info});
  if(p.url.includes('popup')){
   const popup={targetId:'popup'+(++seq),type:'page',url:'http://127.0.0.1:2/idp',title:'synthetic-private-canary',openerId:target};
   targets.set(popup.targetId,popup);event('Target.targetCreated',{targetInfo:popup});
  }
  return reply({frameId:target});}
 case 'Target.closeTarget':{
  reply({success:true});setTimeout(()=>{targets.delete(target);event('Target.targetDestroyed',{targetId:target});},150);return;}
 case 'Page.captureScreenshot':
  emit({method:'Page.lifecycleEvent',params:{name:'fixture-capture-started'},sessionId:m.sessionId});
  if(p.fixtureHang)return;
  return setTimeout(()=>reply({data:Buffer.from('synthetic-private-canary').toString('base64')}),100);
 case 'Runtime.evaluate':return reply({result:{type:'string',value:'synthetic-private-canary'}});
 case 'Network.getAllCookies':return reply({cookies:[{name:'fixture',value:'synthetic-private-canary'}]});
 case 'Storage.clearDataForOrigin':
  if(!m.sessionId || sessions.get(m.sessionId)==='browser')return emit({id:m.id,error:{code:-32601,message:'page domain required'}});
  if(p.origin!=='http://127.0.0.1:1' || p.storageTypes!=='all')return emit({id:m.id,error:{code:-32602,message:'exact fixture origin required'}});
  return reply({});
 case 'Page.getFrameTree':return reply({frameTree:{frame:{id:target,url:targets.get(target).url}}});
 case 'DOM.getDocument':return reply({root:{nodeId:1}});
 case 'DOM.querySelector':return reply({nodeId:p.selector==='.signedin'?2:0});
 case 'Input.insertText':{
  const info=targets.get(target);info.title=p.text;event('Target.targetInfoChanged',{targetInfo:info});return reply({});}
 case 'Page.startScreencast':{
  reply({});setTimeout(()=>emit({method:'Page.screencastFrame',sessionId:m.sessionId,params:{sessionId:1,
   data:Buffer.concat([Buffer.from([255,216,255,192,0,8,8,0,240,1,64,3]),Buffer.from('synthetic-private-canary')]).toString('base64'),metadata:{deviceWidth:320,deviceHeight:240}}}),20);return;}
 default:return reply({});
 }
}
`;

type Reply = { id?: number; result?: Record<string, any>; error?: unknown; method?: string };
async function client(url: string) {
  const ws = new WebSocket(url);
  const frames: string[] = [];
  const waiting = new Map<number, (r: Reply) => void>();
  let seq = 0;
  ws.on('message', data => {
    const text = data.toString(); frames.push(text);
    const m = JSON.parse(text) as Reply;
    if (m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  await once(ws, 'open');
  return { ws, frames, async send(method: string, params = {}, sessionId?: string): Promise<Reply> {
    const id = ++seq;
    const result = new Promise<Reply>(resolve => waiting.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return result;
  } };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'broker-'));
  const executablePath = join(dir, 'chromium');
  await writeFile(executablePath, peer); await chmod(executablePath, 0o700);
  const broker = await launchBroker({ executablePath, profileDir: join(dir, 'profile'), member: 'fixture', onExit() {} });
  const endpoint = broker.endpoint().cdpUrl;
  const http = endpoint.replace('ws:', 'http:').replace('/devtools/browser', '/json');
  return { broker, endpoint, http, dir, async close() { await broker.close(); await rm(dir, { recursive: true, force: true }); } };
}
const lease = { epoch: 1, nonce: '0123456789abcdefghijklmnopqrstuv', origin: 'http://127.0.0.1:1', knownIdps: [] };

// One meaningful fixture journey covers the shared production boundary and all client classes.
test('pipe broker: authenticated forwarding, all-client fence, private targets, lease input, release barrier', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const http = new URL(f.http); const token = http.searchParams.get('token')!;
    assert.equal((await fetch(`${http.origin}/json/list`)).status, 401);
    assert.equal((await fetch(f.http.replace('/json?', '/json/list?'), { headers: { origin: 'http://site.test' } })).status, 401);
    const foreign = await new Promise<number>(resolve => {
      get(f.http.replace('/json?', '/json/list?'), { headers: { host: 'foreign.test' } }, res => { res.resume(); resolve(res.statusCode!); });
    });
    assert.equal(foreign, 401);
    assert.equal((await fetch(`${http.origin}/json/list?token=wrong`)).status, 401);
    const agent = await client(f.endpoint), sibling = await client(f.endpoint);
    const attached = await agent.send('Target.attachToTarget', { targetId: 'agent', flatten: true });
    const sid = attached.result!.sessionId as string;
    assert.ok((await agent.send('Runtime.evaluate', { expression: 'fixture' }, sid)).result); // positive control
    assert.ok(agent.frames.some(text => text.includes('synthetic-private-canary')));
    assert.ok((await sibling.send('Runtime.evaluate', {}, sid)).error); // no cross-client session reuse
    assert.ok((await agent.send('Browser.close')).error);
    assert.ok((await agent.send('Browser.setDownloadBehavior', { behavior: 'allow' })).result); // guarded rewrite, required by engine's Playwright connection
    assert.ok((await agent.send('Target.sendMessageToTarget', { sessionId: sid, message: JSON.stringify({ id: 1, method: 'Browser.close' }) })).error);
    const from = agent.frames.length;
    const accepted = once(agent.ws, 'message');
    const screenshot = agent.send('Page.captureScreenshot', {}, sid);
    await accepted; // fixture confirms Chromium accepted it before fence; a WebSocket write alone is not receipt
    const started = Date.now(); await f.broker.fence(true);
    assert.ok(Date.now() - started >= 80); assert.ok((await screenshot).error);
    if (agent.ws.readyState !== WebSocket.CLOSED) await once(agent.ws, 'close');
    if (sibling.ws.readyState !== WebSocket.CLOSED) await once(sibling.ws, 'close');
    assert.equal(agent.ws.readyState, WebSocket.CLOSED);
    assert.equal(sibling.ws.readyState, WebSocket.CLOSED);
    f.broker.bindLease(lease);
    const id = await f.broker.openPrivate('http://127.0.0.1:1/login?popup');
    await new Promise(resolve => setTimeout(resolve, 25));
    const blocked = await client(f.endpoint);
    for (const method of ['Target.getTargets', 'Target.attachToTarget', 'Target.setAutoAttach', 'Page.captureScreenshot',
      'Network.getAllCookies', 'DOM.getDocument', 'Runtime.evaluate', 'Input.insertText']) {
      assert.ok((await blocked.send(method, { targetId: id, text: 'synthetic-private-canary' })).error, method);
    }
    assert.equal((await fetch(`${http.origin}/json/list?token=${token}`)).status, 409);
    assert.ok((await blocked.send('Byokit.claimTakeover', { epoch: 0, nonce: lease.nonce })).error);
    assert.ok((await blocked.send('Byokit.claimTakeover', { epoch: 1, nonce: 'wrong' })).error);
    const control = f.broker.attachViewer({ lease });
    const frame = await control.frames[Symbol.asyncIterator]().next();
    assert.ok(!frame.done); assert.ok(Buffer.from(frame.value!.jpeg).includes(Buffer.from('synthetic-private-canary'))); assert.equal(frame.value!.w, 320); assert.equal(frame.value!.h, 240); // dropped-frame positive control
    assert.throws(() => f.broker.attachViewer({ lease }));
    assert.throws(() => f.broker.attachViewer({}));
    assert.throws(() => f.broker.attachViewer({ lease, maxWidth: 0 }));
    const state = f.broker.privateState()!;
    assert.equal(state.origin, 'http://127.0.0.1:2'); assert.equal(state.offOrigin, true);
    control.input({ kind: 'text', text: 'synthetic-private-canary' }); // paused, not delivered
    assert.equal(f.broker.confirmOrigin({ epoch: 0, nonce: lease.nonce }, state.origin), false);
    assert.equal(f.broker.confirmOrigin(lease, 'https://127.0.0.1:2'), false);
    assert.equal(f.broker.confirmOrigin(lease, state.origin), true);
    assert.equal(f.broker.privateState()!.offOrigin, false);
    control.input({ kind: 'text', text: 'synthetic-private-canary' });
    assert.equal(agent.frames.slice(from).filter(text => text.includes('synthetic-private-canary')).length, 0);
    assert.equal(blocked.frames.filter(text => text.includes('synthetic-private-canary')).length, 0);
    await assert.rejects(f.broker.clearSite([lease.origin]));
    f.broker.bindLease(null); assert.throws(() => f.broker.attachViewer({ lease }));
    await assert.rejects(f.broker.fence(false));
    const closing = f.broker.closePrivate();
    assert.throws(() => f.broker.bindLease({ ...lease, epoch: 2 }));
    await assert.rejects(f.broker.fence(false));
    const closeStart = Date.now(); await closing; assert.ok(Date.now() - closeStart >= 100);
    assert.equal(f.broker.privateState(), undefined);
    await f.broker.fence(false);
    await f.broker.navigateAgent('reload');
    const back = await client(f.endpoint);
    const discovered = await back.send('Target.getTargets');
    assert.deepEqual(discovered.result!.targetInfos.map((t: { targetId: string }) => t.targetId), ['agent']);
    assert.ok((await back.send('Storage.clearDataForOrigin', { origin: lease.origin, storageTypes: 'all' })).error); // original root-domain failure positive control
    await f.broker.clearSite([lease.origin]); // only succeeds with an owned page session + exact requested origin
    await assert.rejects(f.broker.clearSite(['https://site.test/path']));
    const prefs = JSON.parse(await readFile(join(f.dir, 'profile/Default/Preferences'), 'utf8'));
    assert.equal(prefs.credentials_enable_service, false); assert.equal(prefs.autofill.profile_enabled, false);
    await f.broker.fence(true);
    assert.throws(() => f.broker.bindLease(lease)); // epochs never reused
    f.broker.bindLease({ ...lease, epoch: 2 }); await f.broker.openPrivate('http://127.0.0.1:1/login');
    const holder = await client(f.endpoint);
    const claimed = (await holder.send('Byokit.claimTakeover', { ...lease, epoch: 2 })).result!;
    const privateSid = (await holder.send('Target.attachToTarget', { targetId: claimed.targetId, flatten: true })).result!.sessionId;
    assert.ok((await holder.send('Runtime.evaluate', {}, privateSid)).error);
    assert.ok((await holder.send('Page.reload', { scriptToEvaluateOnLoad: 'globalThis.fixtureBypass=true' }, privateSid)).error);
    assert.ok((await holder.send('Input.insertText', { text: 'fixture', command: 'evaluate' }, privateSid)).error);
    assert.ok((await holder.send('Page.startScreencast', { format: 'jpeg', maxWidth: 1000000 }, privateSid)).error);
    assert.equal(await f.broker.probe('http://127.0.0.1:1/verify', async p => p.status === 200 && await p.exists('.signedin'), 1000), 'ok');
    assert.equal(await f.broker.probe('http://127.0.0.1:1/verify-401-iframe', async p => p.status === 200, 1000), 'fail'); // iframe 200 cannot verify an anonymous main document
    f.broker.bindLease(null); await f.broker.closePrivate(); await f.broker.fence(false);
  } finally { await f.close(); }
});

test('unknown in-flight command fails closed within the five-second barrier', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const agent = await client(f.endpoint);
    const sid = (await agent.send('Target.attachToTarget', { targetId: 'agent', flatten: true })).result!.sessionId;
    const accepted = once(agent.ws, 'message');
    const waiting = agent.send('Page.captureScreenshot', { fixtureHang: true }, sid);
    await accepted;
    const started = Date.now();
    await assert.rejects(f.broker.fence(true));
    assert.ok(Date.now() - started < 5500);
    assert.ok((await waiting).error);
    await assert.rejects(f.broker.fence(false));
    await assert.rejects(f.broker.openPrivate('http://127.0.0.1:1/login'));
  } finally { await f.close(); }
});

test('missing explicit Chromium executable fails promptly without awaiting a nonexistent process', { timeout: 2000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'broker-missing-'));
  try {
    await assert.rejects(launchBroker({ executablePath: join(dir, 'missing'), profileDir: join(dir, 'p'), member: 'fixture', onExit() {} }), /browser command failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
