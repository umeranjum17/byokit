// O8 acceptance (5.8) over the O7 fake gateway: ordered streaming, member boundary refusal, optional bridge
// registration, abort, a resting wait error, and no listener or registration leak across 100 runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { createRuns } from '../src/runs.ts';
import type { GatewayTransport, Member, RunEvent } from '../src/types.ts';

/** createRuns wired to a fresh fake: a recording bridge double and a live-listener counter around the transport. */
function harness() {
  const fake = fakeGateway();
  const t = fake.factory({ port: 0, token: 't', identityPath: '', bridgeSock: '' });
  const registered: string[] = [];
  const unregistered: string[] = [];
  let live = 0;
  const onEvent: GatewayTransport['onEvent'] = (fn) => {
    live++;
    const off = t.onEvent(fn);
    return () => {
      live--;
      off();
    };
  };
  const ensure = async (member: Member) => {
    const list = await t.request('agents.list') as { agents: { id: string }[] };
    if (!(list.agents ?? []).some((agent) => agent.id === member)) await t.request('agents.create', { name: member });
    return { agentId: member };
  };
  const runs = createRuns({
    request: t.request,
    onEvent,
    ensure,
    bridge: { register: (r) => registered.push(r.sessionKey), unregister: (k) => unregistered.push(k) },
  });
  return { fake, runs, registered, unregistered, listeners: () => live };
}

test('a run streams its events in order and ends ok', async () => {
  const h = harness();
  const events: RunEvent[] = [];
  const end = await h.runs.run(
    { member: 'm1', sessionKey: 'agent:m1:main', message: 'please [tool note {"x":1}] now' },
    (e) => events.push(e),
  );
  const text = 'fake: please [tool note {"x":1}] now';
  assert.deepEqual(end, { ok: true, text });
  assert.deepEqual(events, [
    { type: 'tool', name: 'note', phase: 'start' },
    { type: 'tool', name: 'note', phase: 'end' },
    { type: 'text', text },
    { type: 'text', text }, // the final cumulative text event
  ]);
  const call = h.fake.calls.find((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.equal(call.agentId, 'm1');
  assert.equal(call.sessionKey, 'agent:m1:main');
  assert.equal(call.message, 'please [tool note {"x":1}] now');
  assert.ok(typeof call.idempotencyKey === 'string' && call.idempotencyKey.length > 0);
});

test("a member cannot run in another member's session, refused before any request", async () => {
  const h = harness();
  await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'agent:m2:other:1', message: 'hello' }), /m2/);
  await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'chat:m1:main', message: 'hello' }));
  assert.deepEqual(h.fake.calls, []);
});

test('register:false skips the bridge; a default run registers and unregisters once', async () => {
  const h = harness();
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:unreg', message: 'hello', register: false });
  assert.deepEqual(h.registered, []);
  assert.deepEqual(h.unregistered, []);
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:reg', message: 'hello' });
  assert.deepEqual(h.registered, ['agent:m1:reg']);
  assert.deepEqual(h.unregistered, ['agent:m1:reg']);
});

test('aborting mid-run ends the run aborted', async () => {
  const h = harness();
  const key = 'agent:m1:abort';
  const pending = h.runs.run({ member: 'm1', sessionKey: key, message: 'hello' }, (e) => {
    if (e.type === 'text') void h.runs.abort(key);
  });
  assert.deepEqual(await pending, { ok: false, aborted: true });
  assert.deepEqual(h.unregistered, [key]);
});

test('a usage-limit wait error rests with an until about five minutes out', async () => {
  const h = harness();
  h.fake.failNext('agent.wait', 'usage limit, try again in 5 min');
  const before = Date.now();
  const end = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:rest', message: 'hello' });
  assert.ok(!end.ok && 'kind' in end, JSON.stringify(end));
  assert.equal(end.message, 'usage limit, try again in 5 min');
  assert.equal(end.kind, 'resting');
  assert.ok(end.until !== undefined && Math.abs(end.until - (before + 300_000)) < 5_000, `until ${end.until}`);
});

test('steer and abort address the session key', async () => {
  const h = harness();
  await h.runs.steer('agent:m1:s', 'go faster');
  await h.runs.abort('agent:m1:s');
  assert.deepEqual(
    h.fake.calls.filter((c) => c.method === 'sessions.steer' || c.method === 'chat.abort'),
    [
      { method: 'sessions.steer', params: { sessionKey: 'agent:m1:s', message: 'go faster' } },
      { method: 'chat.abort', params: { sessionKey: 'agent:m1:s' } },
    ],
  );
});

test('a hundred concurrent runs leave no listener or registration behind', async () => {
  const h = harness();
  const ends = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    h.runs.run({ member: 'm1', sessionKey: `agent:m1:leak:${i}`, message: `run ${i}` })));
  for (const end of ends) assert.ok(end.ok, JSON.stringify(end));
  assert.equal(h.listeners(), 0);
  assert.equal(h.registered.length, 100);
  assert.equal(h.unregistered.length, 100);
  assert.deepEqual([...h.unregistered].sort(), [...h.registered].sort());
});
