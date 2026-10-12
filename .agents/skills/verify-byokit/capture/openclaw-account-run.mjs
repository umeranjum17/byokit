import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/account-run-');
const index = () => JSON.parse(readFileSync(join(stateDir, 'openclaw', 'accounts', 'm1.json'), 'utf8')).accounts;
const fake = fakeGateway();
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
const agentRequests = () => fake.calls.filter((c) => c.method === 'agent').length;
const run = async (label, spec) => {
  const events = [];
  const before = agentRequests();
  const end = await kit.run({ member: 'm1', message: 'hello', ...spec }, (e) => { if (e.type === 'account') events.push(e); });
  const shown = events.map(({ considered, ...e }) => ({ ...e, considered: considered.map((r) => [r.id, r.left, r.out ?? r.tier, r.reason]) }));
  console.log(`${label}:`, JSON.stringify({ account: shown[0], end, agentRequests: agentRequests() - before }));
  return { end, event: events[0], requests: agentRequests() - before };
};
try {
  await kit.start();
  await (await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {})).done;
  const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', name: 'Personal' }, () => {});
  await second.done;
  const agent = `m1--${second.id.slice('openai.'.length)}`;
  fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 80 }]);
  fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 10 }]);
  for (const a of await kit.accounts('m1')) await kit.room('m1', a.id); // the fake's usage cache is cold on its first read
  console.log('accounts:', JSON.stringify((await kit.accounts('m1')).map((a) => [a.id, a.name, a.state])));

  const plain = await run('no account', { sessionKey: 'agent:m1:plain' });
  assert.ok(plain.end.ok && !('account' in plain.end) && !plain.event);

  const auto = await run('auto', { sessionKey: 'agent:m1:chat:1', account: 'auto' });
  assert.equal(auto.event.account, second.id);
  assert.equal(auto.event.sessionKey, `agent:${agent}:chat:1`);
  assert.ok(auto.end.ok && auto.end.account === second.id && auto.end.model === 'openai/default');

  fake.failNext('agent', 'You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.');
  const rested = await run('resting end', { sessionKey: 'agent:m1:chat:2', account: 'auto' });
  console.log('index until:', index()[second.id].until, 'state:', (await kit.accounts('m1')).find((a) => a.id === second.id).state);
  assert.equal(index()[second.id].until, rested.end.until);
  const next = await run('next auto', { sessionKey: 'agent:m1:chat:3', account: 'auto' });
  assert.equal(next.event.account, 'openai');

  // Error cases: a chosen account whose own sign-in is gone, an empty pick, and an id the member does not have.
  await kit.callDynamic('byokit.accounts', { action: 'clear', agentId: agent });
  fake.handle('models.list', (p) => ({ models: [{ id: 'default', name: 'Default', provider: 'openai',
    ...(p.agentId === agent ? { available: false, unavailableReason: 'missing-auth' } : { available: true }) }] }));
  const out = await run('signed-out account', { sessionKey: 'agent:m1:chat:4', account: second.id });
  assert.deepEqual([out.end.kind, out.requests], ['signed-out', 0]);
  fake.failNext('agent', 'usage limit reached');
  await run('member account rests', { sessionKey: 'agent:m1:chat:5', account: 'auto' });
  const none = await run('none', { sessionKey: 'agent:m1:chat:6', account: 'auto' });
  assert.deepEqual([none.end.kind, none.requests], ['signed-out', 0]);
  await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:7', message: 'hi', account: 'openai.ffffff' }), (error) => {
    console.log('refused:', `${error.constructor.name}: ${error.message}`);
    return /unknown account: openai\.ffffff/.test(error.message);
  });
  console.log('ACCOUNT-RUN OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
