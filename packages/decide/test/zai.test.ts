// Z.AI coding-plan decisions: the plan key or plan account answers over the chat-completions wire with a strict
// json_schema, billed to the member's Z.AI plan only. Fake fetch throughout; no lab key, so no live leg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, UnsupportedAccountError, zai, ZAI_ROUTES, type Question } from '../src/index.ts';

const questions: Record<string, Question> = {
  intent: { kind: 'choice', options: {
    task: 'Something new to do', followup: 'About an earlier job', chat: 'Just talking' } },
  urgent: { kind: 'yesno', question: 'Urgent?' },
  rating: { kind: 'score', levels: ['low', 'medium', 'high'] },
};
const answers = {
  intent: { probabilities: { task: 0.1, followup: 0.8, chat: 0.1 }, pick: 'followup', rationale: 'Earlier job.' },
  urgent: { probabilities: { true: 0.9, false: 0.1 }, pick: 'true', rationale: 'Fire.' },
  rating: { probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, pick: '2', rationale: 'Strong.' },
};
const completed = {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answers) } }],
  usage: { prompt_tokens: 84, completion_tokens: 67 },
};
const account = (provider: 'zai' | 'zai-coding-cn' = 'zai', token = 'zai-plan-key') =>
  ({ provider, billing: 'subscription' as const, access: async () => token });

test('an app decides on a Z.AI plan key over the chat-completions wire, plan-billed only', async () => {
  assert.deepEqual(ZAI_ROUTES, { apiKey: { billing: 'subscription', offer: false },
    account: { billing: 'subscription', offer: true, consentRequired: true } });
  let sent: any;
  const backend = zai({ model: 'glm-5.2', key: 'zai-plan-key', fetch: async (url, init) => {
    assert.equal(url, 'https://api.z.ai/api/coding/paas/v4/chat/completions');
    assert.equal((init!.headers as any).authorization, 'Bearer zai-plan-key');
    sent = JSON.parse(init!.body as string);
    return Response.json(completed);
  } });
  assert.equal(backend.name, 'zai');
  const result = await decide({ text: 'Earlier job, still pending.' }, questions, { privacy: 'may-leave', backends: [backend] });
  assert.deepEqual([result.intent.answer, result.urgent.answer, result.rating.answer], ['followup', true, 2]);
  for (const a of Object.values(result)) {
    assert.equal(a.by, 'zai');
    assert.equal(a.confidenceSource, 'self-reported');
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, completed);
  }
  assert.equal(sent.model, 'glm-5.2');
  assert.equal(sent.messages[0].role, 'system');
  assert.deepEqual(sent.response_format.type, 'json_schema');
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.deepEqual(sent.response_format.json_schema.schema.properties.rating.properties.pick.enum, ['0', '1', '2']);
  assert.ok(!JSON.stringify(result).includes('zai-plan-key'), 'the plan key never lands in an answer');
});

test('the coding-cn route and its plan account reach their own endpoint, and a misplaced plan account is refused', async () => {
  const urls: string[] = [];
  const fetch = async (url: string | URL | Request) => { urls.push(String(url)); return Response.json(completed); };
  await decide({}, { urgent: questions.urgent }, { privacy: 'may-leave', backends: [zai({ model: 'glm-5.2', key: 'cn-key', route: 'zai-coding-cn', fetch })] });
  await decide({}, { urgent: questions.urgent }, { privacy: 'may-leave',
    backends: [zai({ model: 'glm-5.2', account: account('zai-coding-cn', 'cn-key'), fetch })] });
  assert.deepEqual(urls, ['https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
    'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions']);

  assert.throws(() => zai({ model: 'glm-5.2', account: account('zai') as any, route: 'zai-coding-cn' }), /route must match/);
  assert.throws(() => zai({ model: 'glm-5.2', key: 'k', route: 'opencode-go' as any }), /route must be zai or zai-coding-cn/);
  assert.throws(() => zai({ model: 'glm-5.2', key: 'k', account: account() } as any), /not both/);
  for (const bad of ['', '  ', 42] as any[]) assert.throws(() => zai({ model: 'glm-5.2', key: bad }), /needs a key/);
  assert.throws(() => zai({ model: '  ', key: 'k' }), /explicit model/);
  assert.throws(() => zai({ model: 'glm-5.2', account: account('opencode-go' as any) as any }), /This is a opencode-go plan account; pass it on the opencode-go route/);
  assert.throws(() => zai({ model: 'glm-5.2', account: { billing: 'subscription', access: async () => 'k' } as any }), /no provider tag/);
  assert.throws(() => zai({ model: 'glm-5.2', account: { provider: 'zai', billing: 'api', access: async () => 'k' } as any }), UnsupportedAccountError);
});

test('a refused Z.AI key or account abstains with a typed failure that never carries the key or the body', async () => {
  const refusal = (status: number, key: string) => async () =>
    Response.json({ error: { message: `Invalid API key ${key}` } }, { status });
  const ask = (status: number, input: { key: string } | { account: ReturnType<typeof account> }, key: string) =>
    decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [zai({
      model: 'glm-5.2', ...input, fetch: refusal(status, key), maxRetries: 1, retryBaseMs: 0 } as any)] });
  for (const [input, key] of [[{ key: 'sk-zai-plan-key' }, 'sk-zai-plan-key'],
    [{ account: account('zai', 'sk-zai-account-key') }, 'sk-zai-account-key']] as const) {
    for (const [status, code] of [[401, 'key_refused'], [403, 'key_refused'], [402, 'out_of_credit'], [429, 'rate_limited']] as const) {
      const a = (await ask(status, input, key)).intent;
      assert.equal(a.abstained, true);
      assert.deepEqual(a.failure, { code, status }, `${status} on ${'key' in input ? 'the key' : 'the account'}`);
      assert.equal(a.reason, `zai failed: http ${status}`);
      assert.ok(!JSON.stringify(a).includes(key) && !JSON.stringify(a).includes('Invalid API key'), 'no key or provider words in the answer');
    }
  }
  const broken = (await ask(500, { key: 'sk-zai-plan-key' }, 'sk-zai-plan-key')).intent;
  assert.deepEqual([broken.reason, broken.failure], ['zai failed: http 500', undefined]);
  await assert.rejects(ask(404, { account: account() }, 'zai-plan-key'), UnsupportedAccountError);
});

test('a cut-off, refused or malformed reply abstains and keeps its usage and raw response', async () => {
  const replies = [
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify(answers) } }], usage: completed.usage },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'no' } }], usage: completed.usage },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'not json' } }], usage: completed.usage },
  ];
  for (const reply of replies) {
    const a = (await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [zai({ model: 'glm-5.2', key: 'k',
      fetch: async () => Response.json(reply) })] })).intent;
    assert.equal(a.abstained, true);
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, reply);
  }
});

test('a plan account that cannot hand a key abstains before any request, with no fallback route', async () => {
  let fetched = 0;
  const signedOut = { provider: 'zai' as const, billing: 'subscription' as const, access: async () => { throw new Error('signed out'); } };
  const result = await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [zai({
    model: 'glm-5.2', account: signedOut, fetch: async () => { fetched++; throw new Error('must not fetch'); },
  })] });
  assert.equal(result.intent.abstained, true);
  assert.equal(fetched, 0);
});
