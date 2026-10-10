// O7 acceptance (5.11): every default handler exercised directly through transport.request, failNext/drop as
// documented, and the model stub answering the script grammar. No engine, no account, loopback only.
import { createServer } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fakeGateway, type FakeScript } from '../src/testing/fake-gateway.ts';
import { STUB_USAGE, startModelStub, toolCalls, useModelStub, releaseStub, stubHolding, type ModelStub } from '../src/testing/model-stub.ts';
import type { OpenClawKit } from '../src/kit.ts';
import type { GatewayTransport } from '../src/types.ts';
import { scratchDir } from '../../test-support.ts';

const METHODS = [
  'agent', 'agent.wait', 'agents.create', 'agents.list', 'chat.abort', 'config.get', 'config.patch',
  'exec.approval.request', 'exec.approval.resolve', 'health', 'models.authStatus', 'openclaw.setup.auth.start',
  'plugin.approval.resolve', 'question.resolve', 'sessions.steer', 'wizard.cancel', 'wizard.next',
];
const EVENTS = [
  'agent',
  'exec.approval.requested', 'exec.approval.resolved',
  'plugin.approval.requested', 'plugin.approval.resolved',
  'question.requested', 'question.resolved',
];

const transport = (fake: ReturnType<typeof fakeGateway>, bridgeSock = '') =>
  fake.factory({ port: 0, token: 't', identityPath: '', bridgeSock });

/** request(), typed for the assertions. */
const req = <T2 = any>(t: GatewayTransport, method: string, params?: unknown): Promise<T2> =>
  t.request(method, params) as Promise<T2>;

/** A stand-in for the kit's real bridge: the same newline-framed one-request-per-connection protocol. */
async function startBridge(answers: { gate?: Record<string, unknown>; call?: Record<string, unknown> } = {}) {
  const frames: Record<string, any>[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const frame = JSON.parse(buffer.slice(0, end));
      frames.push(frame);
      socket.pause();
      const reply = frame.kind === 'gate'
        ? (answers.gate ?? { allow: true, permit: 'permit-1' })
        : (answers.call ?? { ok: true, text: `bridge ${frame.tool}` });
      socket.end(JSON.stringify(reply) + '\n');
    });
  });
  const path = join(scratchDir('bridge'), 'b.sock');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  return { path, frames, close: () => new Promise<void>((yes) => server.close(() => yes())) };
}

const post = (stub: ModelStub, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${stub.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify(body),
  });

/** One scripted completion; returns the assembled content, any tool calls, or the error body. */
async function complete(stub: ModelStub, messages: unknown[]): Promise<any> {
  const res = await post(stub, '/v1/chat/completions', { model: 'test', messages });
  if (!res.ok) return { status: res.status, error: (await res.json() as any).error };
  const chunks = (await res.text()).split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)));
  const content = chunks.map((c) => c.choices[0]?.delta.content).filter((c) => typeof c === 'string').join('');
  const tools = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
  return { status: res.status, content, tools, chunks };
}

test('the fake hello carries the protocol, the pinned version and the served methods and events', async () => {
  const fake = fakeGateway();
  const hello = await fake.transport.start();
  assert.equal(hello.protocol, 4);
  assert.equal(hello.server.version, '2026.8.35');
  for (const method of METHODS) assert.ok(hello.methods.includes(method), `missing ${method}`);
  for (const event of EVENTS) assert.ok(hello.events.includes(event), `missing ${event}`);
});

test('unknown methods are refused and every request is recorded', async () => {
  const fake = fakeGateway();
  await assert.rejects(fake.transport.request('nope.method', { a: 1 }), /unknown method: nope\.method/);
  assert.deepEqual(fake.calls, [{ method: 'nope.method', params: { a: 1 } }]);
  await fake.transport.request('health');
  assert.deepEqual(fake.calls[1], { method: 'health', params: undefined });
});

test('wizard.cancel cancels its own session and the session is gone', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  await req(t, 'openclaw.setup.auth.start', { sessionId: 's2', agentId: 'm1', authChoice: 'openai-device-code' });
  assert.deepEqual(await req(t, 'wizard.cancel', { sessionId: 's2' }), { status: 'cancelled' });
  await assert.rejects(req(t, 'wizard.next', { sessionId: 's2' }), /unknown wizard session/);
});

test('a plain run streams one assistant text and the wait resolves ok', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  await req(t, 'agents.create', { name: 'm1' });
  const events: any[] = [];
  const off = t.onEvent((e) => events.push(e));
  const run = await req(t, 'agent', { agentId: 'm1', sessionKey: 'agent:m1:x:1', message: 'hello there', idempotencyKey: 'k1' });
  assert.ok(run.runId);
  const waited = await req(t, 'agent.wait', { runId: run.runId });
  assert.deepEqual(waited, { status: 'ok', terminalReply: { text: 'fake: hello there' } });
  const mine = events.filter((e) => e.event === 'agent' && e.payload.runId === run.runId);
  assert.deepEqual(mine.map((e) => e.payload.stream), ['assistant']);
  assert.equal(mine[0].payload.data.text, 'fake: hello there');
  off();
  await assert.rejects(req(t, 'agent.wait', { runId: 'nope' }), /unknown run/);
  await assert.rejects(req(t, 'agent', { agentId: 'ghost', sessionKey: 'agent:ghost:x', message: 'hi' }), /unknown agent: ghost/);
});

test('expectFinal hands the accepted frame over and settles with the run\'s final frame and usage', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  await req(t, 'agents.create', { name: 'm1' });
  const accepted: any[] = [];
  const final = await t.request('agent', { agentId: 'm1', sessionKey: 'agent:m1:f:1', message: 'hi', idempotencyKey: 'kf',
    provider: 'xai', model: 'grok-4' }, { expectFinal: true, onAccepted: (p) => accepted.push(p) }) as any;
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].status, 'accepted');
  assert.deepEqual(final, { runId: accepted[0].runId, status: 'ok', summary: 'completed', result: { payloads: [{ text: 'fake: hi' }],
    meta: { agentMeta: { provider: 'xai', model: 'grok-4', usage: { input: 2, output: 8, total: 10 } } } } });
  // Without expectFinal the reply is the accepted frame itself, as before.
  const ack = await req(t, 'agent', { agentId: 'm1', sessionKey: 'agent:m1:f:2', message: 'hi', idempotencyKey: 'kg' });
  assert.equal(ack.status, 'accepted');
  await req(t, 'agent.wait', { runId: ack.runId });
});

test('abort resolves the pending wait as aborted', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  await req(t, 'agents.create', { name: 'm1' });
  const run = await req(t, 'agent', { agentId: 'm1', sessionKey: 'agent:m1:x:2', message: 'hello', idempotencyKey: 'k2' });
  const waited = req(t, 'agent.wait', { runId: run.runId });
  await req(t, 'chat.abort', { sessionKey: 'agent:m1:x:2' });
  assert.deepEqual(await waited, { status: 'error', stopReason: 'rpc' });
  assert.deepEqual(await req(t, 'sessions.steer', { sessionKey: 'agent:m1:x:2', message: 'one thing' }), {});
});

test('tool calls cross a real bridge: nested json, permit, start/end pairs', async () => {
  const bridge = await startBridge();
  try {
    const fake = fakeGateway();
    const t = transport(fake, bridge.path);
    await req(t, 'agents.create', { name: 'm1' });
    const events: any[] = [];
    t.onEvent((e) => events.push(e));
    const message = '[tool alpha {"x":{"y":1},"s":"a}b"}] then [tool beta {"z":[1,2]}]';
    const run = await req(t, 'agent', { agentId: 'm1', sessionKey: 'agent:m1:t:1', message, idempotencyKey: 'k3' });
    const waited = await req(t, 'agent.wait', { runId: run.runId });
    assert.equal(waited.status, 'ok');
    const mine = events.filter((e) => e.event === 'agent' && e.payload.runId === run.runId);
    assert.deepEqual(mine.map((e) => [e.payload.stream, e.payload.data.name, e.payload.data.phase]), [
      ['tool', 'alpha', 'start'], ['tool', 'alpha', 'result'], ['tool', 'beta', 'start'], ['tool', 'beta', 'result'], ['assistant', undefined, undefined],
    ]);
    // Engine-shaped fields: a toolCallId pairing start and result, the args on start, the result and isError on result.
    assert.deepEqual(mine.slice(0, 2).map((e) => e.payload.data), [
      { phase: 'start', name: 'alpha', toolCallId: 'call-1', args: { x: { y: 1 }, s: 'a}b' } },
      { phase: 'result', name: 'alpha', toolCallId: 'call-1', isError: false, result: { content: [{ type: 'text', text: 'bridge alpha' }] } },
    ]);
    assert.deepEqual(bridge.frames, [
      { kind: 'gate', key: 'agent:m1:t:1', tool: 'alpha', input: { x: { y: 1 }, s: 'a}b' } },
      { kind: 'call', key: 'agent:m1:t:1', permit: 'permit-1', tool: 'alpha', input: { x: { y: 1 }, s: 'a}b' } },
      { kind: 'gate', key: 'agent:m1:t:1', tool: 'beta', input: { z: [1, 2] } },
      { kind: 'call', key: 'agent:m1:t:1', permit: 'permit-1', tool: 'beta', input: { z: [1, 2] } },
    ]);
  } finally {
    await bridge.close();
  }
});

test('a denied gate calls nothing and still plays the tool pair', async () => {
  const bridge = await startBridge({ gate: { allow: false, reason: 'nope' } });
  try {
    const fake = fakeGateway();
    const t = transport(fake, bridge.path);
    await req(t, 'agents.create', { name: 'm1' });
    const events: any[] = [];
    t.onEvent((e) => events.push(e));
    const run = await req(t, 'agent', { agentId: 'm1', sessionKey: 'agent:m1:t:2', message: '[tool alpha {"x":1}]', idempotencyKey: 'k4' });
    const waited = await req(t, 'agent.wait', { runId: run.runId });
    assert.equal(waited.status, 'ok');
    const mine = events.filter((e) => e.event === 'agent' && e.payload.runId === run.runId);
    assert.deepEqual(mine.map((e) => [e.payload.stream, e.payload.data.phase]), [['tool', 'start'], ['tool', 'result'], ['assistant', undefined]]);
    assert.deepEqual(mine[1].payload.data, { phase: 'result', name: 'alpha', toolCallId: 'call-1', isError: true,
      result: { content: [{ type: 'text', text: 'nope' }] } });
    assert.deepEqual(bridge.frames.map((f) => f.kind), ['gate']);
  } finally {
    await bridge.close();
  }
});

test('without a bridge the tool pair still plays and the run ends ok', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  await req(t, 'agents.create', { name: 'm1' });
  const events: any[] = [];
  t.onEvent((e) => events.push(e));
  const run = await req(t, 'agent', { agentId: 'm1', sessionKey: 'agent:m1:t:3', message: '[tool alpha {"x":1}]', idempotencyKey: 'k5' });
  const waited = await req(t, 'agent.wait', { runId: run.runId });
  assert.equal(waited.status, 'ok');
  const mine = events.filter((e) => e.event === 'agent' && e.payload.runId === run.runId);
  assert.deepEqual(mine.map((e) => e.payload.stream), ['tool', 'tool', 'assistant']);
});

test('config patches merge under the memory invariant and check the hash', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  const first = await req(t, 'config.get');
  assert.deepEqual(first.config, {});
  const patched = await req(t, 'config.patch', { baseHash: first.hash, raw: JSON.stringify({
    models: { providers: { p: { baseUrl: 'http://x' } } },
    memory: { search: { provider: 'openai', fallback: 'openai' } },
  }) });
  assert.notEqual(patched.hash, first.hash);
  const after = await req(t, 'config.get');
  assert.equal(after.config.memory.search.provider, 'none');
  assert.equal(after.config.memory.search.fallback, 'none');
  assert.equal(after.config.models.providers.p.baseUrl, 'http://x');
  await assert.rejects(req(t, 'config.patch', { baseHash: first.hash, raw: '{}' }), /stale config/);
  // Like the real engine (O11 probe): entries without explicit ownership are rejected, even a lone one,
  // because the engine always carries main alongside. The kit writes what the engine normalizes on boot.
  await assert.rejects(req(t, 'config.patch', { raw: JSON.stringify({ agents: { entries: { m9: {} } } }) }),
    /agents.ownership/);
  await req(t, 'config.patch', { raw: JSON.stringify({ agents: { ownership: 'explicit',
    entries: { m9: { memory: { search: { provider: 'openai', fallback: 'openai' } } } } } }) });
  const entries = await req(t, 'config.get');
  assert.equal(entries.config.agents.entries.m9.memory.search.provider, 'none');
  assert.equal(entries.config.agents.entries.m9.memory.search.fallback, 'none');
});

test('approval resolvers emit their resolved events and exec.approval.request emits requested', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  const events: any[] = [];
  t.onEvent((e) => events.push(e));
  assert.deepEqual(await req(t, 'exec.approval.request', { id: 'e1', command: 'ls', ask: 'may i',
    agentId: 'm1', sessionKey: 'agent:m1:fake:1' }), { id: 'e1' });
  // Engine shape: title+description required, the id is minted (O11).
  const plugin = await req(t, 'plugin.approval.request', { title: 'install x', description: 'd', agentId: 'm1' }) as { id: string };
  assert.ok(typeof plugin.id === 'string' && plugin.id.length > 0);
  await assert.rejects(req(t, 'plugin.approval.request', { title: 'install x', agentId: 'm1' }), /title and description/);
  assert.deepEqual(await req(t, 'exec.approval.resolve', { id: 'e1', decision: 'allow' }), {});
  assert.deepEqual(await req(t, 'plugin.approval.resolve', { id: plugin.id, decision: 'deny' }), {});
  assert.deepEqual(await req(t, 'question.resolve', { id: 'q1', answers: { answers: {} } }), {});
  assert.deepEqual(events.map((e) => e.event), [
    'exec.approval.requested', 'plugin.approval.requested', 'exec.approval.resolved', 'plugin.approval.resolved',
    'question.resolved',
  ]);
  // Real engine shape: details nest under `request` (B1).
  assert.equal(events[0].payload.approvalKind, 'exec');
  assert.deepEqual(events[0].payload.request,
    { command: 'ls', ask: 'may i', agentId: 'm1', sessionKey: 'agent:m1:fake:1' });
  assert.equal(events[1].payload.approvalKind, 'plugin');
  assert.deepEqual(events[1].payload.request, { title: 'install x', description: 'd', agentId: 'm1', sessionKey: undefined });
  assert.deepEqual(events[2].payload, { id: 'e1', decision: 'allow' });
});

test('failNext fails exactly the next call per queued message', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  fake.failNext('health', 'boom');
  fake.failNext('health', 'bam');
  await assert.rejects(req(t, 'health'), /boom/);
  await assert.rejects(req(t, 'health'), /bam/);
  assert.equal((await req(t, 'health')).ok, true);
});

test('drop closes the transports, refuses them, and a fresh one reconnects', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  const closed: string[] = [];
  const off = t.onClose((why) => closed.push(why));
  fake.drop('engine exited');
  assert.deepEqual(closed, ['engine exited']);
  await assert.rejects(req(t, 'health'), /transport closed: engine exited/);
  const fresh = transport(fake);
  assert.equal((await req(fresh, 'health')).ok, true);
  off();
});

test('handle registers and overrides, and the hello lists the served methods', async () => {
  const fake = fakeGateway();
  const t = transport(fake);
  fake.handle('health', () => ({ ok: false }));
  assert.equal((await req(t, 'health')).ok, false);
  fake.handle('custom.thing', (p) => ({ got: p.x }));
  assert.deepEqual(await req(t, 'custom.thing', { x: 1 }), { got: 1 });
  const hello = await t.start();
  assert.ok(hello.methods.includes('custom.thing'));
});

test('a fakeGateway script pre-registers handlers over the defaults', async () => {
  const script: FakeScript = { health: () => ({ ok: true, scripted: true }) };
  const fake = fakeGateway(script);
  assert.deepEqual(await fake.transport.request('health'), { ok: true, scripted: true });
});

test('the tool-call parser matches nested braces and quotes', () => {
  assert.deepEqual(toolCalls('no tools here'), []);
  assert.deepEqual(toolCalls('before [tool a {"x":{"y":1}}] after'), [{ name: 'a', input: { x: { y: 1 } } }]);
  assert.deepEqual(toolCalls('[tool a {"s":"brace } here"}][tool b {"n":[1,2]}]'), [
    { name: 'a', input: { s: 'brace } here' } }, { name: 'b', input: { n: [1, 2] } },
  ]);
  assert.deepEqual(toolCalls('[tool a {"q":"say \\"hi\\""}]'), [{ name: 'a', input: { q: 'say "hi"' } }]);
});

test('the stub replies done with the last line and names the bot from its system prompt', async () => {
  const stub = await startModelStub();
  try {
    const out = await complete(stub, [
      { role: 'system', content: 'Your id is chief.' },
      { role: 'user', content: 'hello\nmy last line' },
    ]);
    assert.equal(out.status, 200);
    assert.equal(out.content, 'stub chief: done with "my last line"');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].authorization, 'Bearer test-key');
    assert.equal(stub.calls[0].path, '/v1/chat/completions');
  } finally {
    await stub.close();
  }
});

test('the stub reports its usage chunk only when asked, like OpenAI', async () => {
  const stub = await startModelStub();
  try {
    const plainReply = await complete(stub, [{ role: 'user', content: 'hello' }]);
    assert.equal(plainReply.chunks.some((c: any) => c.usage), false);
    const res = await post(stub, '/v1/chat/completions', { model: 'test', stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }] });
    const chunks = (await res.text()).split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)));
    assert.deepEqual(chunks.at(-1).usage, STUB_USAGE);
    assert.deepEqual(chunks.at(-1).choices, []);
  } finally {
    await stub.close();
  }
});

test('the stub drives tools across turns: call, then the result reply', async () => {
  const stub = await startModelStub();
  try {
    const first = await complete(stub, [{ role: 'user', content: '[tool crew_x {"a":{"b":2},"c":"}"}]' }]);
    assert.equal(first.status, 200);
    assert.equal(first.content, '');
    assert.equal(first.tools.length, 1);
    assert.equal(first.tools[0].function.name, 'crew_x');
    assert.deepEqual(JSON.parse(first.tools[0].function.arguments), { a: { b: 2 }, c: '}' });
    const second = await complete(stub, [
      { role: 'user', content: '[tool crew_x {"a":{"b":2},"c":"}"}]' },
      { role: 'tool', tool_call_id: first.tools[0].id, name: 'crew_x', content: 'the tool said so' },
    ]);
    assert.equal(second.content, 'stub bot: crew_x said the tool said so');
  } finally {
    await stub.close();
  }
});

test('the limit script answers the usage-limit error', async () => {
  const stub = await startModelStub();
  try {
    const out = await complete(stub, [{ role: 'user', content: 'hit the limit for me' }]);
    assert.equal(out.status, 429);
    assert.match(out.error.message, /hit your ChatGPT usage limit/);
    assert.match(out.error.message, /Try again in ~30 min\./);
  } finally {
    await stub.close();
  }
});

test('the plan and sign-out scripts answer their errors', async () => {
  const stub = await startModelStub();
  try {
    const plan = await complete(stub, [{ role: 'user', content: 'no helpers in plan today' }]);
    assert.equal(plan.status, 403);
    assert.equal(plan.error.message, "Your plan doesn't include this model.");
    const out = await complete(stub, [{ role: 'user', content: 'sign me out please' }]);
    assert.equal(out.status, 401);
    assert.match(out.error.message, /sign-in has expired/);
  } finally {
    await stub.close();
  }
});

test('queued script replies come before the grammar', async () => {
  const stub = await startModelStub(['first reply', 'second reply']);
  try {
    assert.equal((await complete(stub, [{ role: 'user', content: 'hello' }])).content, 'first reply');
    assert.equal((await complete(stub, [{ role: 'user', content: 'hello' }])).content, 'second reply');
    assert.equal((await complete(stub, [{ role: 'user', content: 'hello' }])).content, 'stub bot: done with "hello"');
  } finally {
    await stub.close();
  }
});

test('ask permission holds the turn until released', async () => {
  const stub = await startModelStub();
  try {
    const pending = complete(stub, [{ role: 'user', content: 'ask permission to roam' }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(stubHolding('Bearer test-key'), 'the turn is not holding');
    releaseStub('Bearer test-key', 'released text');
    assert.equal((await pending).content, 'released text');
    assert.equal(stubHolding(), false);
  } finally {
    releaseStub();
    await stub.close();
  }
});

test('routing answers in shares and embeddings get embeddings', async () => {
  const stub = await startModelStub();
  try {
    const system = { role: 'system', content: 'Your id is chief.' };
    const picked = await complete(stub, [system, { role: 'user', content: '[routing]\n- alpha: a\n- beta: b\n[route beta]' }]);
    assert.deepEqual(JSON.parse(picked.content), { alpha: 0.1, beta: 0.9 });
    const torn = await complete(stub, [system, { role: 'user', content: '[routing]\n- alpha: a\n- beta: b\n[route ?]' }]);
    assert.deepEqual(JSON.parse(torn.content), { alpha: 0.5, beta: 0.5 });
    const embed = await post(stub, '/api/embeddings', { input: ['a', 'b'] });
    assert.deepEqual(await embed.json(), { embeddings: [[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]] });
    assert.equal(stub.calls.at(-1)!.path, '/api/embeddings');
  } finally {
    await stub.close();
  }
});

test('useModelStub points the config at the stub as every agent\'s primary model', async () => {
  const fake = fakeGateway();
  const kit = { call: (m: string, p?: unknown) => fake.transport.request(m, p) } as unknown as OpenClawKit;
  const stub = await startModelStub();
  try {
    await useModelStub(kit, stub);
    const config = await fake.transport.request('config.get') as any;
    const provider = config.config.models.providers['byokit-stub'];
    assert.equal(provider.baseUrl, stub.url);
    assert.equal(provider.api, 'openai-completions');
    assert.equal(provider.models[0].id, 'test');
    assert.equal(config.config.agents.defaults.model.primary, 'byokit-stub/test');
    const patch = fake.calls.find((c) => c.method === 'config.patch')!;
    assert.equal(typeof (patch.params as any).baseHash, 'string');
    assert.deepEqual(stub.calls, []);
  } finally {
    await stub.close();
  }
});

test('the stub takes an explicit id pattern and routing marker', async () => {
  const stub = await startModelStub([], { idPattern: /bot id: (\w+)/, routingMarker: '[dispatch]' });
  try {
    const out = await complete(stub, [
      { role: 'system', content: 'bot id: acme1' },
      { role: 'user', content: 'hello' },
    ]);
    assert.equal(out.content, 'stub acme1: done with "hello"');
    const picked = await complete(stub, [
      { role: 'system', content: 'bot id: acme1' },
      { role: 'user', content: '[dispatch]\n- alpha: a\n- beta: b\n[route beta]' },
    ]);
    assert.deepEqual(JSON.parse(picked.content), { alpha: 0.1, beta: 0.9 });
  } finally {
    await stub.close();
  }
});
