import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, PROVIDERS, billingWords, anthropic, anthropicSseReader, isFunctionCall, ResponseError, type AnthropicStreamEvent, type AnthropicRequest } from '../src/portable.ts';
import { answerer, decide } from '../../decide/src/index.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/anthropic-sse-typescript.json', import.meta.url), 'utf8'));
const good = fixture.cases[0].stream as string;

test('recorded Messages streams: text/tools/thinking, cumulative usage, incomplete and errors at arbitrary boundaries', () => {
  for (const c of fixture.cases) for (const stream of [c.stream, c.stream.replace(/\n/g, '\r\n'), c.stream.replace(/\n/g, '\r')]) {
    for (const chunks of [[stream], [...stream]]) {
      const deltas: string[] = [], events: AnthropicStreamEvent[] = [];
      const r = anthropicSseReader((d) => deltas.push(d), (e) => events.push(e));
      const run = () => { for (const chunk of chunks) r.push(chunk); return r.result(); };
      if (c.error) { assert.throws(run, (e: any) => e instanceof ResponseError && e.message.includes(c.error) && (!c.kind || e.kind === c.kind), c.name); continue; }
      const result = run();
      assert.equal(result.text, c.text, c.name);
      assert.equal(deltas.join(''), c.text);
      assert.equal(result.status, c.status);
      assert.equal(result.incompleteReason, c.reason);
      assert.deepEqual(result.usage, { input_tokens: 25, output_tokens: 15, cache_read_input_tokens: 5 });
      assert.equal(r.result(), result, 'finish is idempotent');
      assert.equal(events.filter((e) => e.type === 'message_stop').length, 1);
      assert.equal(events.filter((e) => e.type === 'incomplete').length, c.reason ? 1 : 0);
      if (c.tool) {
        const call = result.output[0]; assert.ok(isFunctionCall(call));
        assert.deepEqual(JSON.parse(call.arguments), c.tool);
        assert.equal(call.call_id, 'tool_recorded');
        assert.equal(events.filter((e) => e.type === 'tool_use').length, 1);
        assert.deepEqual(('input' in result.raw.content[0] ? result.raw.content[0].input : undefined), c.tool);
      }
      if (c.partial) {
        assert.equal(result.output.filter(isFunctionCall).length, 0);
        assert.equal(events.filter((e) => e.type === 'tool_use').length, 0);
        assert.equal(('partial_json' in result.raw.content[0] ? result.raw.content[0].partial_json : undefined), c.partial);
      }
      if (c.thinking) {
        assert.equal(('thinking' in result.raw.content[0] ? result.raw.content[0].thinking : undefined), c.thinking);
        assert.equal(('signature' in result.raw.content[0] ? result.raw.content[0].signature : undefined), 'recorded-signature');
      }
    }
  }
});

const stub = (stream = good, streaming = true) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const f = (async (url: any, init: RequestInit) => {
    requests.push({ url: String(url), init });
    if (!streaming) return { ok: true, body: undefined, text: async () => stream } as unknown as Response;
    const bytes = new TextEncoder().encode(stream);
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }));
  }) as typeof fetch;
  return { requests, fetch: f };
};

const request: AnthropicRequest = {
  model: 'explicit-model', max_tokens: 4096,
  system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral', ttl: '5m' } }],
  messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'recorded-image' } },
    { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
    { type: 'tool_result', tool_use_id: 'previous-tool', content: [{ type: 'text', text: 'noon' }] },
  ] }],
  tools: [{ name: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
  tool_choice: { type: 'tool', name: 'weather', disable_parallel_tool_use: true },
  thinking: { type: 'enabled', budget_tokens: 1024 }, stop_sequences: ['END'], metadata: { user_id: 'app-member' },
  temperature: 0.5, top_p: 0.9, top_k: 10, service_tier: 'standard_only',
  output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } }, native_future_option: { enabled: true },
};

test('fetch passes native options unchanged, sends only explicit key, and handles byte-split UTF-8 or no-stream fetch', async () => {
  for (const streaming of [true, false]) {
    const s = stub(good, streaming), signal = new AbortController().signal;
    const pieces: string[] = [];
    const result = await anthropic({ key: 'app-owned-key', base: 'https://proxy.test/', fetch: s.fetch, betas: ['explicit-beta'] }).respond({ ...request, result: true, signal, onText: (d) => pieces.push(d) });
    assert.equal(result.text, 'Hello! 👋');
    assert.equal(pieces.join(''), result.text);
    const seen = s.requests[0];
    assert.equal(seen.url, 'https://proxy.test/v1/messages');
    assert.equal(seen.init.signal, signal);
    assert.deepEqual(JSON.parse(String(seen.init.body)), { ...request, stream: true });
    assert.deepEqual(seen.init.headers, { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': 'app-owned-key', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'explicit-beta' });
  }
});

test('plain text and explicit metadata contracts; no tools still returns usage/raw when requested', async () => {
  const p = anthropic({ key: 'key', fetch: stub().fetch });
  const ask = { model: 'explicit', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] };
  assert.equal(await p.respond(ask), 'Hello! 👋');
  const result = await p.respond({ ...ask, result: true });
  assert.equal(result.status, 'completed'); assert.equal(result.raw.id, 'msg_recorded');
  const { tools: _tools, ...noTools } = request;
  for (const c of fixture.cases.filter((c: any) => c.reason)) {
    const incomplete = anthropic({ key: 'key', fetch: stub(c.stream).fetch });
    const events: AnthropicStreamEvent[] = [];
    await assert.rejects(incomplete.respond({ ...noTools, onEvent: (e) => events.push(e) }), /incomplete/);
    assert.equal(events.filter((e) => e.type === 'incomplete').length, 1);
    assert.equal((await incomplete.respond({ ...request, result: true })).incompleteReason, c.reason);
  }
});

test('HTTP and stream errors keep account kinds; failed non-JSON response never echoes a key/body', async () => {
  for (const [status, kind] of [[401, 'signed_out'], [403, 'signed_out'], [429, 'rate_limit'], [529, 'overloaded'], [400, null]] as const) {
    const p = anthropic({ key: 'secret-key', fetch: (async () => new Response('secret-key', { status })) as typeof fetch });
    await assert.rejects(p.respond({ ...request, result: true }), (e: any) => e.kind === kind && !e.message.includes('secret-key'));
  }
  assert.throws(() => anthropic({ key: '' }), /API key/);
  const s = stub(); const p = anthropic({ key: 'key', fetch: s.fetch });
  await assert.rejects(p.respond({ ...request, max_tokens: 0 }), /positive max_tokens/);
  await assert.rejects(p.respond({ ...request, model: '' }), /model/);
  assert.equal(s.requests.length, 0);
});

test('Accounts route is explicit, independent of member credentials, and does not launch a plan login', async () => {
  assert.equal(PROVIDERS.anthropic.label, 'API key (billed per use)');
  assert.equal(billingWords(PROVIDERS.anthropic), 'Charged per use to your Anthropic account, not a plan.');
  const s = stub();
  const a = new Accounts({ offer: ['anthropic'], fetch: s.fetch, store: () => { throw new Error('must not read store'); } });
  const result = await a.respond('member', { ...request, provider: 'anthropic', key: 'app-key', result: true });
  assert.equal(result.text, 'Hello! 👋');
  assert.deepEqual(JSON.parse(String(s.requests[0].init.body)), { ...request, stream: true });
  await assert.rejects(a.login('member', 'anthropic'), /API key/);
  await assert.rejects(new Accounts({ fetch: s.fetch }).respond('member', { ...request, provider: 'anthropic', key: 'key', result: true }), /not offered/);
});

test('decide answerer abstains on an incomplete Messages answer', async () => {
  const p = anthropic({ key: 'key', fetch: stub(fixture.cases.find((c: any) => c.reason === 'max_tokens').stream).fetch });
  const backend = answerer({ name: 'anthropic', leaves: true, ask: (prompt, signal) => p.respond({ model: 'explicit', max_tokens: 100, messages: [{ role: 'user', content: prompt }], signal }) });
  const answers = await decide({}, { ok: { kind: 'yesno', question: 'OK?' } }, { backends: [backend], privacy: 'may-leave' });
  assert.equal(answers.ok.abstained, true);
  assert.match(answers.ok.reason!, /incomplete/);
});
