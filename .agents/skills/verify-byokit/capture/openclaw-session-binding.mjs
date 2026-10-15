import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/session-binding-');
const fake = fakeGateway();
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
const agentRequests = () => fake.calls.filter((c) => c.method === 'agent').length;
const shown = (considered) => considered.map((r) => [r.id, r.left, r.out ?? r.tier, r.reason]);
const run = async (label, spec) => {
  let event;
  const before = agentRequests();
  const end = await kit.run({ member: 'm1', message: 'hello', ...spec }, (e) => { if (e.type === 'account') event = e; });
  const account = event && { ...event, considered: shown(event.considered) };
  console.log(`${label}:`, JSON.stringify({ account, end, agentRequests: agentRequests() - before }));
  return { end, event, requests: agentRequests() - before };
};
const pick = async (label, sessionKey, account) => {
  const p = await kit.pick('m1', { account }, { sessionKey });
  console.log(`${label}:`, JSON.stringify(p.ok ? { account: p.account.id, how: p.how, why: p.why, considered: shown(p.considered) }
    : { code: p.code, reason: p.reason }));
  return p;
};
const sameAsRun = (p, ran) => assert.deepEqual([p.account.id, p.model, p.how, p.why, p.considered],
  [ran.event.account, ran.event.model, ran.event.how, ran.event.why, ran.event.considered]);
const setRoom = async (agent, member, account) => {
  fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 100 - member }]);
  fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 100 - account }]);
  for (const a of await kit.accounts('m1')) await kit.room('m1', a.id); // the fake's usage cache is cold on its first read
};
try {
  await kit.start();
  await (await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', name: 'Work' }, () => {})).done;
  const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', name: 'Personal' }, () => {});
  await second.done;
  const agent = `m1--${second.id.slice('openai.'.length)}`;
  await setRoom(agent, 20, 90);

  // Unbound: pick and run agree; the run lands on Personal's own agent.
  const p1 = await pick('pick chat:1 (unbound)', 'agent:m1:chat:1', 'auto');
  const r1 = await run('run chat:1 auto', { sessionKey: 'agent:m1:chat:1', account: 'auto' });
  sameAsRun(p1, r1);
  assert.equal(r1.event.sessionKey, `agent:${agent}:chat:1`);

  // Work now has the most room, yet chat:1 stays on Personal: no account, 'auto', and refusing Work.
  await setRoom(agent, 90, 20);
  const r2 = await run('run chat:1 again, no account', { sessionKey: 'agent:m1:chat:1' });
  assert.deepEqual([r2.event.account, r2.event.how], [second.id, 'chosen']);
  const p3 = await pick('pick chat:1 (bound)', 'agent:m1:chat:1', 'auto');
  const r3 = await run('run chat:1 auto', { sessionKey: 'agent:m1:chat:1', account: 'auto' });
  sameAsRun(p3, r3);
  const p4 = await pick('pick chat:1 Work', 'agent:m1:chat:1', 'openai');
  const r4 = await run('run chat:1 Work', { sessionKey: 'agent:m1:chat:1', account: 'openai' });
  assert.deepEqual([p4.code, r4.end, r4.requests], ['bound', { ok: false, kind: 'other', message: p4.reason }, 0]);

  // Steer and abort with the app key reach the live run's engine key.
  const aborted = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:1', message: 'hello' }, (e) => {
    if (e.type === 'started') void kit.steer('agent:m1:chat:1', 'and more').then(() => kit.abort('agent:m1:chat:1'));
  });
  const reached = fake.calls.filter((c) => c.method === 'sessions.steer' || c.method === 'chat.abort').map((c) => [c.method, c.params.sessionKey]);
  console.log('steer/abort:', JSON.stringify({ end: aborted, reached }));
  assert.deepEqual(reached, [['sessions.steer', `agent:${agent}:chat:1`], ['chat.abort', `agent:${agent}:chat:1`]]);

  // The API-key lane: addKey indexes it as openai.key; a key-held chat stays bound; the key never reaches the index.
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'sk-verify' }), { status: 'ok' });
  const laneText = readFileSync(`${stateDir}/openclaw/accounts/m1.json`, 'utf8');
  assert.ok(!laneText.includes('sk-verify'), 'the key never reaches the index');
  const laneAgent = 'byokit-key-m1';
  const k1 = await run('run chat:k openai.key', { sessionKey: 'agent:m1:chat:k', account: 'openai.key' });
  assert.ok(k1.end.ok);
  assert.equal(k1.event.sessionKey, `agent:${laneAgent}:chat:k`);
  const p5 = await pick('pick chat:k auto', 'agent:m1:chat:k', 'auto');
  const r5 = await run('run chat:k auto', { sessionKey: 'agent:m1:chat:k', account: 'auto' });
  assert.deepEqual([p5.code, r5.end, r5.requests], ['paid', { ok: false, kind: 'other', message: p5.reason }, 0]);
  const keyed = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:k', message: 'hello', auth: 'apiKey' });
  assert.ok(keyed.ok);
  const keyReq = fake.calls.filter((c) => c.method === 'agent').at(-1);
  assert.deepEqual([keyReq.params.agentId, keyReq.params.sessionKey], [laneAgent, `agent:${laneAgent}:chat:k`]);
  console.log('key lane:', JSON.stringify({ id: 'openai.key', agent: laneAgent, authRun: keyed.ok }));

  await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m1--abcdef:chat:1', message: 'hi' }), (error) => {
    console.log('refused:', `${error.constructor.name}: ${error.message}`);
    return /not a session of member/.test(error.message);
  });
  console.log('SESSION-BINDING OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
