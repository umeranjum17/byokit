import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/move-');
const fake = fakeGateway();
// The app tool holds its call open while `hold` is pending, so a run stays live for the busy leg.
let hold = Promise.resolve();
let entered = () => {};
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0,
  tools: [{ name: 'report', description: 'record progress', parameters: { type: 'object' } }],
  host: { gate: async () => ({ allow: true }), call: async (_run, _tool, input) => { entered(); await hold; return `Progress: ${input.text}`; } } });
const roles = async (sessionKey) => (await kit.call('chat.history', { sessionKey })).messages.map((m) => m.role);
const resolves = async (agentId, tail) => (await kit.call('sessions.resolve', { key: `agent:${agentId}:${tail}`, agentId, allowMissing: true })).ok === true;
const forks = (from) => fake.calls.slice(from).filter((c) => ['sessions.create', 'sessions.delete', 'chat.history', 'chat.inject'].includes(c.method))
  .map((c) => [c.method, c.params]);
const show = (label, value) => console.log(`${label}:`, JSON.stringify(value));
try {
  await kit.start();
  await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done;
  const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', name: 'Personal' }, () => {});
  await second.done;
  const agent = `m1--${second.id.slice('openai.'.length)}`;
  const ref = { member: 'm1', sessionKey: 'agent:m1:chat:1' };

  // A conversation on the member account with a tool call, moved to Personal.
  await kit.run({ ...ref, message: '[tool report {"text":"Working"}]', account: 'openai' });
  show('source rows before', await roles('agent:m1:chat:1'));
  const from = fake.calls.length;
  const moved = await kit.move(ref, second.id);
  show('move to Personal', moved);
  show('engine requests', forks(from));
  assert.deepEqual(moved, { ok: true, session: `agent:${agent}:chat:1` });
  const target = await roles(`agent:${agent}:chat:1`);
  show('target rows', target);
  assert.deepEqual(target, ['user', 'assistant', 'toolResult', 'assistant']);
  show('source still exists', await resolves('m1', 'chat:1'));
  assert.equal(await resolves('m1', 'chat:1'), false);

  // The next run on the app key continues on Personal, after the whole transcript.
  let event;
  const next = await kit.run({ ...ref, message: 'and then' }, (e) => { if (e.type === 'account') event = e; });
  show('next run', { account: event.account, sessionKey: event.sessionKey, ok: next.ok, rows: await roles(`agent:${agent}:chat:1`) });
  assert.equal(event.sessionKey, `agent:${agent}:chat:1`);

  // Error cases: busy while a run is live, close_failed when the engine refuses the delete, unsupported, not ready.
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const live = kit.run({ ...ref, message: '[tool report {"text":"busy"}]' });
  await started;
  const busy = await kit.move(ref, 'openai');
  show('move while live', busy);
  assert.equal(busy.code, 'busy');
  release();
  await live;
  fake.failNext('sessions.delete', `Session agent:${agent}:chat:1 changed before deletion. Retry.`);
  const closeFailed = await kit.move(ref, 'openai');
  show('move whose delete is refused', closeFailed);
  assert.deepEqual([closeFailed.code, closeFailed.live, await resolves(agent, 'chat:1'), await resolves('m1', 'chat:1')],
    ['close_failed', 'agent:m1:chat:1', true, true]);
  const never = await kit.move({ member: 'm1', sessionKey: 'agent:m1:chat:never' }, second.id);
  show('move of a conversation never started', never);
  assert.equal(never.code, 'unsupported');
  await kit.callDynamic('byokit.accounts', { action: 'clear', agentId: agent });
  const unready = await kit.move(ref, second.id);
  show('move to a signed-out account', unready);
  assert.equal(unready.code, 'start_failed');
  await assert.rejects(kit.move({ member: 'm1', sessionKey: 'agent:m2:chat:1' }, 'openai'), (error) => {
    console.log('refused:', `${error.constructor.name}: ${error.message}`);
    return /not a session of member/.test(error.message);
  });
  console.log('MOVE OK');
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
