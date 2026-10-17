// Anthropic key decisions: one forced `decisions` tool answers over the Messages API, API-billed only.
// Fake fetch below; no live call here (no key held).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, anthropic, ANTHROPIC_ROUTES, UnsupportedImagesError, InvalidImageError,
  type ImageInput, type Question } from '../src/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/anthropic-messages.json', import.meta.url), 'utf8'));
const questions: Record<string, Question> = {
  intent: { kind: 'choice', options: {
    task: 'Something new to do', followup: 'About an earlier job', chat: 'Just talking' } },
  urgent: { kind: 'yesno', question: 'Urgent?' },
  rating: { kind: 'score', levels: ['low', 'medium', 'high'] },
};

test('an app decides on an Anthropic key over the Messages endpoint, API-billed only', async () => {
  assert.deepEqual(ANTHROPIC_ROUTES, { apiKey: { billing: 'api', offer: false } });
  let calls = 0;
  let sent: any;
  const backend = anthropic({ model: 'claude-opus-4-6', key: 'test-key', fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal((init!.headers as any)['x-api-key'], 'test-key');
    assert.equal((init!.headers as any)['anthropic-version'], '2023-06-01');
    sent = JSON.parse(init!.body as string);
    return Response.json(fixture.completed);
  } });
  assert.equal(backend.name, 'anthropic');
  const result = await decide({}, questions, { privacy: 'may-leave', backends: [backend] });
  assert.equal(calls, 1);
  assert.deepEqual([result.intent.answer, result.urgent.answer, result.rating.answer], ['followup', true, 2]);
  assert.deepEqual([result.intent.rationale, result.urgent.rationale], ['About an earlier job.', 'The server room is on fire.']);
  for (const a of Object.values(result)) {
    assert.equal(a.by, 'anthropic');
    assert.equal(a.confidenceSource, 'self-reported');
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, fixture.completed);
  }
  assert.equal(sent.model, 'claude-opus-4-6');
  assert.equal(sent.max_tokens, 1024);
  assert.match(sent.system, /self-reported probability/);
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0].role, 'user');
  assert.match(sent.messages[0].content[0].text, /"intent"/);
  assert.equal(sent.tools.length, 1);
  assert.equal(sent.tools[0].name, 'decisions');
  assert.deepEqual(sent.tool_choice, { type: 'tool', name: 'decisions' });
  assert.deepEqual(sent.tools[0].input_schema.properties.rating.properties.pick.enum, ['0', '1', '2']);

  // A refusal, a reply without the tool use and malformed tool input abstain while keeping usage and raw.
  for (const response of [fixture.refusal, fixture.no_tool,
    { ...fixture.completed, content: [{ type: 'tool_use', id: 'toolu_x', name: 'other', input: {} }] },
    { ...fixture.completed, content: [{ type: 'tool_use', id: 'toolu_x', name: 'decisions', input: { intent: 42 } }] }]) {
    const a = (await decide({}, { intent: questions.intent }, { privacy: 'may-leave',
      backends: [anthropic({ model: 'claude-opus-4-6', key: 'fake', fetch: async () => Response.json(response) })] })).intent;
    assert.equal(a.abstained, true);
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, response);
  }

  // A 429 retries on the same key route, then answers; a refused key status never touches another route.
  let tries = 0;
  const retried = await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [anthropic({
    model: 'claude-opus-4-6', key: 'fake', fetch: async () => (++tries === 1
      ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
      : Response.json(fixture.completed)),
  })] });
  assert.equal(retried.intent.answer, 'followup');
  assert.equal(tries, 2);
  // A refused key status surfaces from the backend and abstains the decision; it never touches another route.
  const keyBackend = anthropic({ model: 'claude-opus-4-6', key: 'fake',
    fetch: async () => new Response('', { status: 401 }) });
  await assert.rejects(keyBackend.ask({}, { intent: questions.intent }, new AbortController().signal), /http 401/);
  const refused = await decide({}, { intent: questions.intent },
    { privacy: 'may-leave', backends: [keyBackend] });
  assert.equal(refused.intent.abstained, true);
  assert.deepEqual(refused.intent.failure, { code: 'key_refused', status: 401 });
});

test('the Anthropic backend needs an explicit model and key, and stays API-billed', async () => {
  assert.throws(() => anthropic({ model: '  ', key: 'k' }), /explicit model/);
  for (const bad of [undefined, '', '  ', 42] as any[]) assert.throws(() => anthropic({ model: 'm', key: bad }), /needs a key/);
  for (const bad of [0, -1, 1.5, Number.NaN] as any[]) assert.throws(() => anthropic({ model: 'm', key: 'k', maxTokens: bad }), /maxTokens/);
  assert.equal(anthropic({ model: 'm', key: 'k', maxTokens: 64 }).name, 'anthropic');

  // Images cross as base64 source blocks; a text-only backend and a malformed image are refused before dispatch.
  const shot: ImageInput = { id: 'shot', mime: 'image/png', bytes: new Uint8Array([1]) };
  const vision: Record<string, Question> = { readable: { kind: 'yesno', question: 'Readable?', images: ['shot'] } };
  const seen = anthropic({ model: 'claude-opus-4-6', key: 'test-key', supportsImages: true,
    fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.deepEqual(body.messages[0].content.slice(1), [{ type: 'text', text: 'Image: shot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQ==' } }]);
      return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'decisions',
          input: { readable: { probabilities: { true: 0.9, false: 0.1 }, pick: 'true', rationale: 'Clear type.' } } }],
        stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 3 } });
    } });
  const read = await decide({}, vision, { privacy: 'may-leave', backends: [seen], images: [shot] });
  assert.deepEqual([read.readable.answer, read.readable.rationale], [true, 'Clear type.']);
  const textOnly = anthropic({ model: 'claude-opus-4-6', key: 'test-key', fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(decide({}, vision, { privacy: 'may-leave', backends: [textOnly], images: [shot] }), UnsupportedImagesError);
  await assert.rejects(decide({}, vision, { privacy: 'may-leave', backends: [seen], images: [{ ...shot, bytes: new Uint8Array() }] }), InvalidImageError);
});
