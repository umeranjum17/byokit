// Consumer journeys for the published @byokit/decide surface (the built package exports), driven the way an app
// uses it: typed questions in, typed answers out, rules then the person's own model, with the floors, privacy,
// caching, retries and redaction a caller meets. Every security and correctness contract the old unit cases held
// survives as an assertion inside a journey: private state never reaches a leaving backend, a key only ever rides
// in a request header, diagnostics redact secrets, a recorded answer abstains below its floor, and the eval CLI
// gates on clear-but-wrong. The model wire is faked; no network, no key and no live model is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import {
  decide, resolve, rules, answerer, jev, openai, parseConfig, createDecider, MemoryCache, cacheKey, FLOOR,
  UnsupportedAccountError, UnsupportedImagesError, InvalidImageError, ConfigError,
  type Answer, type Backend, type ImageInput, type Question, type Raw,
} from '@byokit/decide';
import { evaluate, evaluateDecisions, format, parse, replay, summary } from '@byokit/decide/eval';

const options = (task: string, followup: string, chat: string) => ({ task, followup, chat });
const intent = (): Question => ({ kind: 'choice', options: options('Something new to do', 'About an earlier job', 'Just talking'), personReason: true });

test('an app answers a private draft locally, routes the rest with the person\'s own model, and leaks neither state nor a secret', async () => {
  const privateDraft = 'Umer-private-draft-must-not-leave';
  const prompts: string[] = [];
  const model = answerer({ name: 'phone-model', leaves: true, ask: async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ intent: { probabilities: { task: 0.05, followup: 0.9, chat: 0.05 }, personReason: 'The earlier job is still open.' } });
  } });
  const local = rules((state, name) => name === 'ready' ? state === privateDraft : undefined);
  const questions: Record<string, Question> = {
    ready: { kind: 'yesno', question: 'Is the local draft ready?', state: privateDraft, privacy: 'stays-here' },
    intent: { ...intent(), state: { text: 'can you check if the plumber replied?' } },
  };
  const answers = await decide({ text: 'thanks, that worked' }, questions, { privacy: 'may-leave', backends: [local, model] });
  assert.equal(answers.ready.answer, true);
  assert.equal(answers.ready.by, 'rules');
  assert.equal(answers.intent.answer, 'followup');
  assert.equal(answers.intent.by, 'phone-model');
  assert.equal(answers.intent.personReason, 'The earlier job is still open.');
  assert.equal(prompts.length, 1);
  assert.equal(prompts.every((p) => !p.includes(privateDraft)), true, 'the private draft never left the device');
  assert.equal(JSON.stringify(answers).includes(privateDraft), false);

  // A question's privacy narrows the whole call; it can never widen it.
  let asked = 0;
  const leaving = answerer({ name: 'model', leaves: true, ask: async () => { asked++; return '{}'; } });
  const held = await decide({ text: 'book the dentist' }, { intent: intent() }, { privacy: 'stays-here', backends: [leaving] });
  assert.equal(asked, 0);
  assert.equal(held.intent.abstained, true);

  // The answerer still reads legacy probability JSON, and only asks for an explanation on an opted-in question.
  let legacyPrompt = '';
  const legacy = answerer({ name: 'legacy', leaves: false, ask: async (prompt) => { legacyPrompt = prompt; return JSON.stringify({ ready: { true: 0.9, false: 0.1 } }); } });
  const plain = await decide({}, { ready: { kind: 'yesno', question: 'Ready?' } }, { privacy: 'stays-here', backends: [legacy] });
  assert.equal(plain.ready.answer, true);
  assert.equal(legacyPrompt.includes('personReason'), false);

  // A backend that throws a credential gets a redacted diagnostic, never the raw error.
  const secret = 'synthetic-private-credential';
  const broken = answerer({ name: 'broken', leaves: true, ask: async () => { throw new Error(secret); } });
  const failed = await decide('x', { intent: intent() }, { privacy: 'may-leave', backends: [broken] });
  assert.equal(failed.intent.reason, 'broken failed');
  assert.equal(JSON.stringify(failed).includes(secret), false);
});

test('an app that holds a recorded answer applies the floors and explanations exactly as the library does', () => {
  const choice: Question = { kind: 'choice', options: options('A new job', 'About an earlier job', 'Just talk') };
  const raw: Raw = { probabilities: { task: 0.7, followup: 0.2, chat: 0.1 }, confidence: 0.6, pick: 'task' };
  assert.equal(resolve(choice, raw).answer, 'task', 'exactly the floor answers');
  const under = resolve(choice, { ...raw, confidence: 0.59 });
  assert.equal(under.abstained, true);
  assert.match(under.reason!, /below floor 0.6/);
  assert.equal(FLOOR, 0.6);
  assert.equal(resolve(choice, { ...raw, confidence: undefined }).answer, 'task', 'no confidence: the pick\'s probability');

  // An option's own floor is checked on its probability; the runner-up must clear its own.
  const floored: Question = { ...choice, floors: { task: 0.95, followup: 0.05 } };
  assert.equal(resolve(floored, { probabilities: { task: 0.88, followup: 0.1, chat: 0.02 }, confidence: 0.85, pick: 'task' }).answer, 'followup');
  assert.equal(resolve({ ...choice, floors: { task: 0.95, followup: 0.25, chat: 0.25 } },
    { probabilities: { task: 0.5, followup: 0.25, chat: 0.25 }, confidence: 0.4, pick: 'task' }).reason, 'runner-up tie');

  // Malformed, missing and tied answers abstain, never throw.
  for (const bad of [undefined, { probabilities: { task: 0.5, followup: 0.3, chat: 0.1 } },
    { probabilities: { task: 0.9, followup: 0.1 } }, { probabilities: { task: 1.2, followup: -0.2, chat: 0 } },
    { probabilities: { task: 0.45, followup: 0.45, chat: 0.1 }, confidence: 0.9 }] as (Raw | undefined)[]) {
    assert.equal(resolve(choice, bad).abstained, true);
  }
  assert.equal(resolve(choice, undefined).reason, 'no answer');

  // Explanations are opt-in plain text and never change the decision.
  const explained: Question = { ...choice, personReason: true };
  assert.equal(resolve(choice, { ...raw, personReason: 'asks for something new' }).personReason, undefined);
  assert.equal(resolve(explained, { ...raw, personReason: 'asks for something new' }).personReason, 'asks for something new');
  for (const bad of ['', 'x'.repeat(161), 'Two\nlines', 'Two\u2028lines', 'Hidden\u202econtrol', '<b>Markup</b>', '`code`', 42]) {
    const a = resolve(explained, { ...raw, personReason: bad as string });
    assert.equal(a.personReason, undefined);
    assert.equal(a.abstained, false, 'a bad explanation never changes the answer');
  }
  assert.equal(resolve(explained, { ...raw, confidence: 0.1, pick: 'task' }).personReason, undefined, 'abstention omits the explanation');

  // yes/no and score answers are typed; rank needs a complete permutation and finite optional scores.
  assert.equal(resolve({ kind: 'yesno', question: 'Spend money?' }, { probabilities: { true: 0.9, false: 0.1 } }).answer, true);
  assert.equal(resolve({ kind: 'score', levels: ['fine', 'rough', 'unusable'] }, { probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 }, confidence: 0.7 }).answer, 1);
  const rank: Question = { kind: 'rank', candidates: { a: 'first', b: 'second', c: 'third' } };
  const ranked = resolve(rank, { probabilities: {}, ranking: ['b', 'a', 'c'], confidence: 0.9, scores: { b: 12, a: 0, c: -2 } });
  assert.deepEqual([ranked.answer, ranked.scores], [['b', 'a', 'c'], { b: 12, a: 0, c: -2 }]);
  assert.equal(resolve(rank, { probabilities: {}, ranking: ['a', 'a', 'c'], confidence: 0.9 }).reason, 'malformed ranking');
  assert.equal(resolve(rank, { probabilities: {}, ranking: ['a', 'b'], confidence: 0.9 }).abstained, true);
  assert.deepEqual(resolve({ ...rank, candidates: Object.fromEntries([['__proto__', 'First'], ['toString', 'Second']]) },
    { probabilities: {}, confidence: 1, ranking: ['toString', '__proto__'] }).answer, ['toString', '__proto__'], 'names that shadow properties are ordinary candidates');
});

test('an app caches a decision and isolates keys per state, question override and backend allowlist', async () => {
  const q: Question = { kind: 'choice', options: options('New', 'Earlier', 'Talk') };
  let calls = 0;
  const backend = () => answerer({ name: 'model', leaves: true, ask: async () => {
    calls++;
    return { text: JSON.stringify({ intent: { probabilities: { task: 0.9, followup: 0.05, chat: 0.05 }, pick: 'task' } }),
      usage: { input_tokens: 11, output_tokens: 5 }, rationale: 'Clear.' };
  } });
  const cache = new MemoryCache();
  const first = await decide({ text: 'hi' }, { intent: q }, { privacy: 'may-leave', backends: [backend()], cache });
  assert.deepEqual([first.intent.answer, first.intent.source, calls, cache.size], ['task', 'api', 1, 1]);
  const hit = await decide({ text: 'hi' }, { intent: q }, { privacy: 'may-leave', backends: [], cache });
  assert.deepEqual([hit.intent.source, hit.intent.answer, calls], ['cache', 'task', 1]);
  assert.deepEqual(hit.intent.usage, first.intent.usage, 'usage rides through the cache');
  assert.deepEqual(hit.intent.raw, first.intent.raw, 'the raw response rides through the cache');
  await decide({ text: 'bye' }, { intent: q }, { privacy: 'may-leave', backends: [backend()], cache });
  assert.equal(calls, 2, 'a different state misses');

  // cacheKey is a stable sha256 of the canonical body; overrides and privacy change it.
  const key = cacheKey({ text: 'hi' }, { intent: q });
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, cacheKey({ text: 'hi' }, { intent: q }));
  assert.notEqual(key, cacheKey({ text: 'bye' }, { intent: q }));
  assert.notEqual(key, cacheKey({ text: 'hi' }, { intent: { ...q, personReason: true } }));
  assert.notEqual(key, cacheKey({ text: 'hi' }, { intent: { ...q, backends: ['rules'] } }));

  // A sync, an async and a broken cache all behave; a broken cache never fails a decision.
  const store = new Map<string, Record<string, Answer>>();
  const asyncCache = { get: async (k: string) => store.get(k), set: async (k: string, v: Record<string, Answer>) => { store.set(k, v); } };
  const once = await decide({ text: 'hi' }, { intent: q }, { privacy: 'may-leave', backends: [backend()], cache: asyncCache });
  const twice = await decide({ text: 'hi' }, { intent: q }, { privacy: 'may-leave', backends: [backend()], cache: asyncCache });
  assert.deepEqual([once.intent.source, twice.intent.source], ['api', 'cache']);
  const broken = { get: async () => { throw new Error('disk gone'); }, set: async () => { throw new Error('disk gone'); } };
  const live = await decide({ text: 'hi' }, { intent: q }, { privacy: 'may-leave', backends: [backend()], cache: broken });
  assert.deepEqual([live.intent.answer, live.intent.source], ['task', 'api']);
});

const jevReply = (answers: Record<string, unknown>) => new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
const jevChoice = { kind: 'choice', options: options('A new job', 'About an earlier job', 'Just talk') } as const;
const jevQuestions = (): Record<string, Question> => ({
  intent: jevChoice,
  spends: { kind: 'yesno', question: 'Does it spend?', yes: 'Money moves', no: 'Nothing is bought' },
  rough: { kind: 'score', levels: ['calm', 'upset'], instructions: 'How upset?' },
});

test('an app asks Jev over TypeSafe and OpenRouter with the host key only in the header and bounded 429 retries', async () => {
  process.env.TYPESAFE_API_KEY = 'canary-environment-key';
  process.env.OPENROUTER_API_KEY = 'canary-environment-key';
  try {
    assert.throws(() => jev({ key: '' }), /needs a key/);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answers = {
      intent: { type: 'choice', choice: 'followup', confidence: 0.8, probabilities: { task: 0.1, followup: 0.85, chat: 0.05 } },
      spends: { type: 'noul', noul: 0.02 },
      rough: { type: 'score', score: 0.2, confidence: 0.8, probabilities: { 0: 0.8, 1: 0.2 } },
    };
    const questions = jevQuestions();
    for (const via of ['typesafe', 'openrouter'] as const) {
      const out = await decide({ msg: 'did the plumber call back?' }, questions, { privacy: 'may-leave', backends: [jev({ key: 'host-key', via, fetch: async (url, init) => { calls.push({ url: String(url), init: init! }); return jevReply(answers); } })] });
      assert.deepEqual([out.intent.answer, out.spends.answer, out.rough.answer], ['followup', false, 0]);
    }
    assert.deepEqual(calls.map((c) => c.url), ['https://api.typesafe.ai/v1/systemone', 'https://openrouter.ai/api/v1/systemone']);
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer host-key');
    assert.equal(JSON.stringify(calls).includes('canary-environment-key'), false, 'never the environment key');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      model: 'jev-latest',
      state: { msg: 'did the plumber call back?' },
      questions: {
        intent: { type: 'choice', instructions: 'Which option fits the state?', criteria: jevChoice.options },
        spends: { type: 'noul', instructions: 'Does it spend?', criteria: { true: 'Money moves', false: 'Nothing is bought' } },
        rough: { type: 'score', instructions: 'How upset?', criteria: ['calm', 'upset'] },
      },
    });

    // Privacy keeps the state home; a malformed answer abstains but keeps its usage and raw response.
    let asked = 0;
    await decide({ msg: 'private' }, { intent: questions.intent }, { privacy: 'stays-here', backends: [jev({ key: 'host-key', fetch: async () => { asked++; return jevReply(answers); } })] });
    assert.equal(asked, 0);
    const body = { model: 'jev-1.13.0', answers: { intent: { type: 'choice', choice: 'task', confidence: 'high', probabilities: { task: 0.9, followup: 0.05, chat: 0.05 } } }, usage: { input_tokens: 7, output_tokens: 3 } };
    const broken = await decide('x', { intent: questions.intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: async () => new Response(JSON.stringify(body)) })] });
    assert.deepEqual([broken.intent.abstained, broken.intent.reason], [true, 'malformed answer']);
    assert.deepEqual(broken.intent.usage, { input_tokens: 7, output_tokens: 3 });
    assert.deepEqual(broken.intent.raw, body);

    // A 429 retries with backoff; other statuses never do; an abort during backoff settles promptly.
    let calls2 = 0;
    const flaky: typeof fetch = async () => {
      calls2++;
      return calls2 === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
        : jevReply({ intent: { type: 'choice', choice: 'task', confidence: 0.9, probabilities: { task: 0.95, followup: 0.03, chat: 0.02 } } });
    };
    const retried = await decide('x', { intent: questions.intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: flaky, retryMaxMs: 1000 })] });
    assert.deepEqual([retried.intent.answer, calls2], ['task', 2]);
    for (const status of [400, 401, 500]) {
      let n = 0;
      const r = await decide('x', { intent: questions.intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: async () => { n++; return new Response('', { status }); }, retryBaseMs: 1 })] });
      assert.deepEqual([r.intent.reason, n], [`jev failed: http ${status}`, 1], `no retry on ${status}`);
    }
    let limited = 0;
    const exhausted = await decide('x', { intent: questions.intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', maxRetries: 1, retryBaseMs: 1, fetch: async () => { limited++; return new Response('', { status: 429 }); } })] });
    assert.deepEqual([exhausted.intent.reason, limited], ['jev failed: http 429', 2]);
    let backoff = 0;
    const start = Date.now();
    const aborted = await decide('x', { intent: questions.intent }, { privacy: 'may-leave', timeoutMs: 30, backends: [jev({ key: 'k', retryMaxMs: 60000, fetch: async () => { backoff++; return new Response('', { status: 429, headers: { 'retry-after': '30' } }); } })] });
    assert.equal(aborted.intent.abstained, true);
    assert.match(aborted.intent.reason!, /abort|timed out/i);
    assert.equal(backoff, 1);
    assert.ok(Date.now() - start < 5000, 'the 30 s backoff aborted instead of waiting');

    // A backend that ignores abort cannot answer late or block the next backend in the chain.
    const next = () => rules(() => 'task');
    const late: Backend = { name: 'late', leaves: false, ask: async () => { await new Promise((r) => setTimeout(r, 50)); return { intent: { probabilities: { task: 0, followup: 0, chat: 1 } } }; } };
    const never: Backend = { name: 'never', leaves: false, ask: () => new Promise(() => {}) };
    for (const stubborn of [late, never]) {
      const out = await decide('x', { intent: questions.intent }, { privacy: 'stays-here', backends: [stubborn, next()], timeoutMs: 10 });
      assert.deepEqual([out.intent.answer, out.intent.by], ['task', 'rules'], `${stubborn.name} never wins after its deadline`);
    }
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('an app decides with an OpenAI model, validates its config once, and uses a consented plan without billing a key', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/openai-responses.json', import.meta.url), 'utf8'));
  const questions: Record<string, Question> = {
    intent: { kind: 'choice', options: options('A new job', 'About an earlier job', 'Just talk') },
    urgent: { kind: 'yesno', question: 'Urgent?' },
    rating: { kind: 'score', levels: ['low', 'medium', 'high'] },
  };
  let sent: any;
  const backend = openai({ key: 'test-key', model: 'gpt-6.1-sol',
    request: { reasoning: { effort: 'low' }, max_output_tokens: 1024, instructions: 'Use the supplied rubric.' },
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal((init!.headers as any).authorization, 'Bearer test-key');
      sent = JSON.parse(init!.body as string);
      return Response.json(fixture.completed);
    } });
  const result = await decide({}, questions, { privacy: 'may-leave', backends: [backend] });
  assert.deepEqual([result.intent.answer, result.urgent.answer, result.rating.answer], ['followup', true, 2]);
  assert.equal(result.intent.confidenceSource, 'self-reported');
  for (const a of Object.values(result)) {
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, fixture.completed);
  }
  assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.match(sent.instructions, /Use the supplied rubric/);
  assert.equal(sent.text.format.strict, true);
  assert.deepEqual(sent.text.format.schema.properties.rating.properties.pick.enum, ['0', '1', '2']);

  // A refusal, a cut-off reply and malformed JSON abstain while keeping usage and the raw response.
  for (const response of [fixture.refusal, fixture.incomplete,
    { ...fixture.completed, output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] }]) {
    const a = (await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [openai({ key: 'fake', model: 'gpt-6.1-sol', fetch: async () => Response.json(response) })] })).intent;
    assert.equal(a.abstained, true);
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, response);
  }

  // parseConfig validates portable config; createDecider sets one backend with per-call overrides.
  assert.deepEqual(parseConfig(), { backend: 'jev', auth: 'apiKey' });
  for (const bad of ['{', [], { backend: 'other' }, { auth: 'token' }, { maxRetries: -1 }]) assert.throws(() => parseConfig(bad), ConfigError);
  assert.throws(() => parseConfig({ backend: 'jev', auth: 'account' }), UnsupportedAccountError);
  let calls = 0;
  const run = createDecider(parseConfig({ backend: 'openai', model: 'gpt-6.1-sol' }), { privacy: 'may-leave',
    host: { keys: { openai: 'openai-key', jev: 'jev-key' }, fetch: async (url) => {
      calls++;
      if (String(url).endsWith('/systemone')) return Response.json({ answers: { intent: { choice: 'task', probabilities: { task: 0.9, followup: 0.05, chat: 0.05 }, confidence: 0.9 } } });
      return Response.json(fixture.completed);
    } } });
  assert.equal((await run({}, { intent: questions.intent })).intent.answer, 'followup');
  assert.equal((await run({}, { intent: questions.intent }, { backend: 'jev' })).intent.answer, 'task');
  assert.equal(calls, 2, 'each backend has its own call');

  // The account route needs consent and a catalogue entry, consumes a completed SSE stream and never bills a key.
  const { chatgptPlan } = await import('@byokit/accounts/chatgpt-plan');
  let granted: string[] = ['resource.invoke', 'chatgpt.tokens.use.direct'];
  let visible = true;
  let planCalls = 0;
  const account = chatgptPlan({ session: async () => ({ accessToken: 'plan-token', scopes: granted }) });
  const plan = openai({ auth: 'account', account, model: 'gpt-6.1-sol', fetch: async (url, init) => {
    planCalls++;
    assert.equal((init!.headers as any).authorization, 'Bearer plan-token');
    if (url === 'https://api.openai.com/v1/models') return Response.json({ models: visible ? [{ slug: 'gpt-6.1-sol', visibility: 'list' }] : [] });
    const events = [{ type: 'response.completed', response: fixture.completed }];
    const bytes = new TextEncoder().encode(events.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }));
  } });
  assert.equal((await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [plan] })).intent.answer, 'followup');
  visible = false;
  await assert.rejects(decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [plan] }), UnsupportedAccountError);
  const before = planCalls;
  granted = ['openid'];
  await assert.rejects(decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [plan] }), UnsupportedAccountError);
  assert.equal(planCalls, before, 'no consent: no fetch and no API-key fallback');

  // Images cross the vision adapter as named content parts; a text-only backend and a malformed image are refused before dispatch.
  const shot: ImageInput = { id: 'shot', mime: 'image/png', bytes: new Uint8Array([1]) };
  const vision: Record<string, Question> = { readable: { kind: 'yesno', question: 'Readable?', images: ['shot'] } };
  const imageBackend = openai({ key: 'test-key', model: 'gpt-6.1-sol', supportsImages: true, fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(body.input[0].content.slice(1), [{ type: 'input_text', text: 'Image: shot' },
      { type: 'input_image', image_url: 'data:image/png;base64,AQ==', detail: 'auto' }]);
    assert.deepEqual(JSON.parse(body.input[0].content[0].text).questions.readable.images, ['shot']);
    return Response.json({ status: 'completed', usage: { input_tokens: 8, output_tokens: 3 }, output: [{ type: 'message',
      content: [{ type: 'output_text', text: '{"readable":{"probabilities":{"true":0.9,"false":0.1},"pick":"true","rationale":"Clear type."}}' }] }] });
  } });
  const read = await decide({}, vision, { privacy: 'may-leave', backends: [imageBackend], images: [shot] });
  assert.deepEqual([read.readable.answer, read.readable.rationale, read.readable.usage], [true, 'Clear type.', { input_tokens: 8, output_tokens: 3 }]);
  await assert.rejects(decide({}, vision, { privacy: 'may-leave', backends: [backend], images: [shot] }), UnsupportedImagesError);
  for (const bad of [[], [{ id: 'shot', mime: 'image/jpeg', dataUrl: 'data:image/png;base64,AQ==' }],
    [{ ...shot, bytes: new Uint8Array() }]] as ImageInput[][]) {
    await assert.rejects(decide({}, vision, { privacy: 'may-leave', backends: [imageBackend], images: bad }), InvalidImageError);
  }
});

test('an operator gates a decision on labelled eval files, offline and from the CLI', async () => {
  const path = new URL('../evals/example-urgent.jsonl', import.meta.url);
  const text = readFileSync(path, 'utf8');
  const example = parse(text);
  assert.equal(format(example), text, 'format round-trips the file');
  const report = await evaluate(example.cases, replay(example.question));
  assert.deepEqual([report.cases, report.agree, report.clearWrong, report.abstained], [5, 4, 0, 1]);
  assert.match(summary('urgent', 'recorded', report), /agree 4\/5 {3}clear-but-wrong 0 \(0%\) {3}abstained 1 \(20%\)/);

  // The library's own evaluateDecisions drives a kit backend over the same labelled file, one call per case.
  let ran = 0;
  const live = await evaluateDecisions(example, { privacy: 'may-leave', backends: [answerer({ name: 'host', leaves: true,
    ask: async () => { ran++; return JSON.stringify({ urgent: { true: 0.9, false: 0.1 } }); } })] });
  assert.deepEqual([live.cases, ran], [5, 5]);

  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  const file = join(scratchDir('eval'), 'answers.jsonl');
  writeFileSync(file, format({ decision: 'urgent', question: { kind: 'yesno', question: 'Urgent?' }, note: 'hand-made', cases: [
    { state: 'x', expect: false, jev: { type: 'noul', noul: 0.9 } },
  ] }));
  const wrong = spawnSync(process.execPath, [cli, file], { encoding: 'utf8' });
  assert.equal(wrong.status, 1, 'clear-but-wrong above the rate fails the run');
  assert.match(wrong.stdout, /clear-but-wrong 1 \(100%\)/);
  assert.equal(spawnSync(process.execPath, [cli, file, '--floor', '0.99'], { encoding: 'utf8' }).status, 0, 'a floor that abstains clears the gate');
  for (const [flag, value] of [['--floor', 'nope'], ['--max-clear-wrong', '1.1'], ['--floor', '']] as const) {
    assert.equal(spawnSync(process.execPath, [cli, file, flag, value], { encoding: 'utf8' }).status, 2, `${flag} ${value}`);
  }
});
