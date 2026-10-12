// Run edges no kit-level or engine test reaches: Codex reset deadlines, malformed account refusal, output schema
// validation and refusal, plan-window mapping, and final-payload authority over capped snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { createRuns } from '../src/runs.ts';
import type { GatewayTransport, Member, RunEvent, OutputSchema } from '../src/types.ts';

/** createRuns wired to a fresh fake: a recording bridge double and a live-listener counter around the transport. */
function harness(reply?: string) {
  const fake = fakeGateway();
  const t = fake.factory({ port: 0, token: 't', identityPath: '', bridgeSock: '' });
  const registered: string[] = [];
  const unregistered: string[] = [];
  const subsets: (readonly string[] | undefined)[] = [];
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
  const runs = createRuns({ routes: new Map(),
    request: async (method, params, options) => {
      const result = await t.request(method, params, method === 'agent' ? { ...options, onAccepted: (payload) => {
        options?.onAccepted?.(payload);
        const runId = (payload as { runId: string }).runId;
        for (const progressTokens of [12, -1, NaN, '12']) fake.emit('agent', { runId, stream: 'thinking', data: { progressTokens } });
        fake.emit('agent', { runId: 'another-run', stream: 'thinking', data: { progressTokens: 99 } });
        fake.emit('agent', { runId, stream: 'lifecycle', data: { phase: 'start' } });
      } } : options);
      if (method === 'agent' && reply !== undefined) return { ...(result as object),
        result: { ...(result as { result: object }).result, payloads: [{ text: reply }] } };
      return method === 'agent.wait' && reply !== undefined
        ? { ...(result as object), terminalReply: { text: reply } } : result;
    },
    onEvent,
    ensure,
    bridge: { register: (r, tools) => { registered.push(r.sessionKey); subsets.push(tools); return () => { unregistered.push(r.sessionKey); }; } },
    tools: new Set(['report', 'lookup']),
  });
  return { fake, runs, registered, unregistered, subsets, listeners: () => live };
}

test('the Codex "Next reset in N min/hours" wording carries its stated deadline; no number keeps the fallback', async () => {
  for (const [message, ms] of [
    ["You've reached your Codex subscription usage limit. Next reset in 4 hours, 3:00 PM.", 4 * 3_600_000],
    ['You have hit your ChatGPT usage limit. Next reset in 45 minutes.', 45 * 60_000],
    ['You have hit your ChatGPT usage limit. Next reset in 1 hour.', 3_600_000],
    ['usage limit, try again in 5 min', 300_000],
  ] as const) {
    const h = harness();
    h.fake.failNext('agent.wait', message);
    const before = Date.now();
    const end = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:rest', message: 'hello' });
    assert.ok(!end.ok && 'kind' in end, JSON.stringify(end));
    assert.equal(end.kind, 'resting', message);
    assert.ok(end.until !== undefined && Math.abs(end.until - (before + ms)) < 5_000, `${message}: until ${end.until}`);
  }
  // A rate limit that names no reset keeps the fallback: no until on RunEnd.
  const h = harness();
  h.fake.failNext('agent.wait', 'You have hit your usage limit (plus plan).');
  const end = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:rest', message: 'hello' });
  assert.ok(!end.ok && 'kind' in end, JSON.stringify(end));
  assert.equal(end.kind, 'resting');
  assert.equal('until' in end, false);
});

test('a malformed account or an @profile pin is refused before any request', async () => {
  const h = harness();
  for (const model of ['gpt-5.1', '/gpt-5.1', 'openai/', 'openai/gpt-5.1@openai:me@example.com', 'openai/gpt 5'])
    await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'agent:m1:bad', message: 'hello', model }), /provider\/model/);
  assert.deepEqual(h.fake.calls, []);
});

test('a run names only kit tools: an unknown one is refused before any request, the subset reaches the bridge', async () => {
  const h = harness();
  await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'agent:m1:t', message: 'hi', tools: ['report', 'shell'] }),
    /"shell" is not one of this kit's tools/);
  assert.deepEqual(h.fake.calls, []);
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:t', message: 'hi', tools: ['lookup'] });
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:all', message: 'hi' });
  assert.deepEqual(h.subsets, [['lookup'], undefined]);
});


/** createRuns over a hand-driven transport: the `agent` request plays `play` then settles with `final`. */
function scripted(o: { text?: string; final?: unknown; wait?: unknown; auth?: unknown; play?: (emit: (stream: string, data: unknown) => void) => void }) {
  const listeners = new Set<(e: { event: string; payload?: unknown }) => void>();
  const calls: string[] = [];
  const request: GatewayTransport['request'] = async (method, _params, opts) => {
    calls.push(method);
    if (method === 'agent') {
      opts?.onAccepted?.({ runId: 'r1', status: 'accepted' });
      o.play?.((stream, data) => { for (const fn of listeners) fn({ event: 'agent', payload: { runId: 'r1', stream, data } }); });
      return o.final ?? { runId: 'r1', status: 'ok' };
    }
    if (method === 'agent.wait') return o.wait ?? { status: 'ok', terminalReply: { text: o.text ?? 'done' } };
    if (method === 'models.authStatus') return o.auth ?? { providers: [] };
    throw new Error(`unexpected ${method}`);
  };
  const runs = createRuns({ routes: new Map(), request, onEvent: (fn) => (listeners.add(fn), () => { listeners.delete(fn); }),
    ensure: async (member) => ({ agentId: member }), bridge: { register: () => () => {} }, tools: new Set() });
  return { runs, calls };
}
const finalWith = (agentMeta: unknown) => ({ runId: 'r1', status: 'ok', summary: 'completed', result: { payloads: [], meta: { agentMeta } } });

test('an in-flight cache replay waits without redispatching; capped JSON fails honestly with no fabricated usage', async () => {
  const requests: unknown[] = [];
  const text = JSON.stringify({ report: 'x'.repeat(6000) });
  const request: GatewayTransport['request'] = async (method, params) => {
    if (method === 'agent') {
      requests.push(params);
      return { runId: 'stable', status: 'in_flight' };
    }
    assert.equal(method, 'agent.wait');
    assert.equal((params as { runId: string }).runId, 'stable');
    return { status: 'ok', terminalReply: { disposition: 'visible', text: text.slice(0, 4095) + '…' } };
  };
  const runs = createRuns({ routes: new Map(), request, onEvent: () => () => {}, ensure: async () => ({ agentId: 'm1' }),
    bridge: { register: () => () => {} }, tools: new Set() });
  const end = await runs.run({ member: 'm1', sessionKey: 'agent:m1:retry', message: 'report', idempotencyKey: 'stable',
    schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] } });
  assert.deepEqual(end, { ok: false, kind: 'output', message: 'The answer did not match the requested format.' });
  assert.equal(requests.length, 1);
  const plain = await runs.run({ member: 'm1', sessionKey: 'agent:m1:retry', message: 'report', idempotencyKey: 'stable' });
  assert.deepEqual(plain, { ok: true, text: text.slice(0, 4095) + '…' });
  assert.equal(requests.length, 2, 'one agent request per caller action; never a hidden final retrieval');
});

test('the plan window is the engine\'s own row for the run\'s provider, and never made up', async () => {
  const spec = { member: 'm1', sessionKey: 'agent:m1:p', message: 'hi' };
  const row = { provider: 'openai', status: 'ok', usage: { providerId: 'openai', plan: 'plus', windows: [
    { label: '5h', usedPercent: 42, resetAt: 1_790_000_000_000 }, { label: 'Week', usedPercent: 7 }, { label: 'bad' }] } };
  const shown = scripted({ final: finalWith({ provider: 'OpenAI' }), auth: { providers: [{ provider: 'xai', usage: row.usage }, row] } });
  assert.deepEqual(await shown.runs.run(spec), { ok: true, text: 'done', planWindow: { provider: 'openai', plan: 'plus',
    windows: [{ label: '5h', usedPercent: 42, resetAt: 1_790_000_000_000 }, { label: 'Week', usedPercent: 7 }] } });
  assert.deepEqual(shown.calls, ['agent', 'agent.wait', 'models.authStatus']);
  // A row without usage, with no windows, for another provider, or an unavailable status: no window.
  for (const auth of [{ providers: [{ provider: 'openai', status: 'ok' }] },
    { providers: [{ provider: 'openai', usage: { windows: [] } }] }, { providers: [{ ...row, provider: 'xai' }] },
    { providers: [], unavailable: { message: 'x' } }]) {
    const none = scripted({ final: finalWith({ provider: 'openai' }), auth });
    assert.deepEqual(await none.runs.run(spec), { ok: true, text: 'done' });
  }
});

test('structured output fails closed for malformed JSON, missing/wrong values and unknown fields', async () => {
  const schema = { type: 'object', properties: { score: { type: 'integer', minimum: 1, maximum: 5 } },
    required: ['score'], additionalProperties: false } as const;
  for (const text of ['not JSON secret-answer', '```json\n{"score":3}\n```', '{}', '{"score":"3"}',
    '{"score":0}', '{"score":6}', '{"score":3.5}', '{"score":3,"extra":true}', 'null']) {
    const s = scripted({ text });
    const end = await s.runs.run({ member: 'm1', sessionKey: 'agent:m1:invalid', message: 'report', schema });
    assert.deepEqual(end, { ok: false, kind: 'output', message: 'The answer did not match the requested format.' });
  }
});

test('supported schema constraints enforce JSON values without coercion or defaults', async () => {
  const cases: [OutputSchema, unknown, unknown][] = [
    [{ type: ['string', 'null'], minLength: 1, maxLength: 1 }, '😀', 'ab'],
    [{ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 2 }, 1.5, 2],
    [{ type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2, uniqueItems: true }, [1, 2], [1, 1]],
    [{ type: 'object', minProperties: 1, maxProperties: 1, additionalProperties: { type: 'boolean' } }, { a: true }, { a: 'true' }],
    [{ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 }, { a: 1 }],
    [{ const: false }, false, true],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, null, 1],
    [{ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1.5, 1],
    [{ allOf: [{ type: 'number' }, { minimum: 1 }], not: { const: 2 } }, 1, 2],
    [{ type: 'object', properties: { blocked: false }, required: ['needed'] }, { needed: 1 }, { needed: 1, blocked: null }],
    [{ type: 'array', items: false }, [], [1]],
  ];
  for (const [schema, good, bad] of cases) {
    for (const [value, ok] of [[good, true], [bad, false]] as const) {
      const s = scripted({ text: JSON.stringify(value) });
      const end = await s.runs.run({ member: 'm1', sessionKey: 'agent:m1:constraints', message: 'report', schema });
      assert.equal(end.ok, ok, JSON.stringify({ schema, value }));
      if (end.ok) assert.deepEqual(end.data, value);
    }
  }
  const infinite = scripted({ text: '{"n":1e400}' });
  assert.equal((await infinite.runs.run({ member: 'm1', sessionKey: 'agent:m1:overflow', message: 'report', schema: {} })).ok, false);
});

test('invalid/unsupported schemas are refused before any member or Gateway request; schemas are snapshotted', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.properties = { loop: cyclic };
  const deep: Record<string, unknown> = {};
  let sub = deep;
  for (let i = 0; i < 34; i++) { sub.items = {}; sub = sub.items as Record<string, unknown>; }
  for (const schema of [null, true, [], { type: 'date' }, { type: ['string', 'string'] }, { format: 'email' },
    { properties: { x: { $ref: 'https://example.com/schema' } } }, { required: [1] }, { minimum: '0' },
    { minItems: -1 }, { enum: [] }, { items: [] }, { oneOf: [] }, { additionalProperties: 1 },
    { const: Infinity }, { default: undefined }, { description: 'x'.repeat(65_536) }, cyclic, deep]) {
    const h = harness();
    await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'agent:m1:bad-schema', message: 'report',
      schema: schema as OutputSchema }), /invalid or unsupported output schema/);
    assert.deepEqual(h.fake.calls, []);
    assert.equal(h.listeners(), 0);
  }
  const schema = { type: 'string', enum: ['before'] } as const;
  const s = scripted({ text: '"before"' });
  const pending = s.runs.run({ member: 'm1', sessionKey: 'agent:m1:snapshot', message: 'report', schema });
  (schema.enum as unknown as string[])[0] = 'after';
  const end = await pending;
  assert.ok(end.ok);
  assert.equal(end.data, 'before');
});

test('runtime required arrays and unions of required lists never promise missing result fields', async () => {
  for (const required of [[] as string[], [] as readonly [] | readonly ['value']]) {
    const s = scripted({ text: '{}' });
    const end = await s.runs.run({ member: 'm1', sessionKey: 'agent:m1:dynamic-required', message: 'report',
      schema: { type: 'object', properties: { value: { type: 'string' } }, required, additionalProperties: false } });
    assert.ok(end.ok && end.data);
    const optional: string | undefined = end.data.value;
    // @ts-expect-error a runtime required-list cannot guarantee the property exists
    const promised: string = end.data.value;
    void promised;
    assert.equal(optional, undefined);
    assert.deepEqual(end.data, {});
  }
});

// Synthetic transport replay of the established engine 2026.8.1 packet boundary, not a provider generation.
test('complete final answers supersede capped snapshots with coherent callbacks and terminal fallbacks', async () => {
  const text = JSON.stringify({ report: 'x'.repeat(27_930) });
  assert.equal(text.length, 27_943);
  const spec = { member: 'm1', sessionKey: 'agent:m1:complete', message: 'report' };
  const frame = (payloads: unknown[]) => ({ result: { payloads, meta: { agentMeta: { usage: { output: 8_684 } } } } });
  const capped = { status: 'ok', terminalReply: { disposition: 'visible', text: text.slice(0, 4095) + '…' } };
  // Final payload authority also handles a missing or partial stream, not just the observed complete stream.
  for (const streamed of [undefined, text.slice(0, 100), text]) {
    const events: RunEvent[] = [];
    const s = scripted({ wait: capped, final: frame([{ text }]), play: (emit) => {
      if (streamed !== undefined) emit('assistant', { text: streamed });
    } });
    const end = await s.runs.run({ ...spec, schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] } },
      (e) => events.push(e));
    assert.ok(end.ok);
    assert.equal(end.text, text);
    assert.deepEqual(end.data, JSON.parse(text));
    assert.deepEqual(end.usage, { output: 8_684 });
    assert.deepEqual(events.at(-1), { type: 'text', text });
    assert.equal(s.calls.filter((c) => c === 'agent').length, 1);
  }
  // Preserve payload order and empty strings, with no trimming or media-to-text coercion.
  const cases: { final: unknown; wait: unknown; streamed?: string; expected: string }[] = [
    { final: frame([{ text: 'first' }, { mediaUrl: 'image' }, { text: 'second' }]), wait: capped, expected: 'first\n\nsecond' },
    { final: frame([{ text: '' }]), wait: capped, streamed: 'transient', expected: '' },
    { final: frame([]), wait: capped, streamed: text, expected: text },
    { final: { status: 'accepted' }, wait: capped, streamed: '', expected: '' },
    { final: frame([{ text: 3 }]), wait: capped, expected: capped.terminalReply.text },
    { final: frame([]), wait: { status: 'ok' }, expected: '' },
    ...['silent', 'empty'].map((disposition) => ({ final: frame([{ text: 'NO_REPLY' }]),
      wait: { status: 'ok', terminalReply: { disposition } }, streamed: 'transient', expected: '' })),
  ];
  for (const c of cases) {
    const events: RunEvent[] = [];
    const s = scripted({ final: c.final, wait: c.wait, play: (emit) => {
      if (c.streamed !== undefined) emit('assistant', { text: c.streamed });
    } });
    const end = await s.runs.run(spec, (e) => events.push(e));
    assert.ok(end.ok);
    assert.equal(end.text, c.expected);
    assert.deepEqual(events.at(-1), { type: 'text', text: c.expected });
  }
  // A late final frame is consumed before the final callback; a rejected frame falls back to the stream.
  for (const reject of [false, true]) {
    const final = new Promise((resolve, fail) => setTimeout(() => reject ? fail(new Error('lost final frame')) : resolve(frame([{ text }])), 10));
    const s = scripted({ final, wait: capped, play: (emit) => emit('assistant', { text }) });
    const events: RunEvent[] = [];
    const end = await s.runs.run(spec, (e) => events.push(e));
    assert.ok(end.ok && end.text === text);
    assert.deepEqual(events.at(-1), { type: 'text', text });
  }
  // A missing final frame must not strand a successful wait receipt beyond the existing grace.
  const keepAlive = setTimeout(() => {}, 6_000);
  try {
    const s = scripted({ final: new Promise(() => {}), wait: capped,
      play: (emit) => emit('assistant', { text }) });
    const events: RunEvent[] = [];
    const end = await s.runs.run(spec, (e) => events.push(e));
    assert.ok(end.ok && end.text === text);
    assert.deepEqual(events.at(-1), { type: 'text', text });
  } finally {
    clearTimeout(keepAlive);
  }
  // Non-successful wait outcomes never become a success from an otherwise complete final payload.
  for (const wait of [{ status: 'error', stopReason: 'aborted' }, { status: 'error', error: 'bad request' }]) {
    const events: RunEvent[] = [];
    const s = scripted({ final: frame([{ text }]), wait });
    const end = await s.runs.run(spec, (e) => events.push(e));
    assert.equal(end.ok, false);
    assert.deepEqual(events, [{ type: 'started' }]);
    if (wait.stopReason) assert.deepEqual(end, { ok: false, aborted: true });
    else assert.ok(!end.ok && 'message' in end && end.message === 'bad request');
  }
});
