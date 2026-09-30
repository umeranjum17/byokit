// The floors, the backends and the eval runner, with a mocked Jev: no key, no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { join } from 'node:path';
import { cacheKey, decide, jev, MemoryCache, resolve, rules, type Question, type Answer } from '../src/index.ts';
import { evaluate, format, parse, replay, summary } from '../src/eval.ts';

const intent: Question = { kind: 'choice', options: { task: 'A new job', followup: 'About an earlier job', chat: 'Just talk' } };
const p = (task: number, followup: number, chat: number) => ({ task, followup, chat });

test('one floor on the answer confidence, as firstmate: 0.6 answers, just under abstains', () => {
  assert.deepEqual(resolve(intent, { probabilities: p(0.7, 0.2, 0.1), confidence: 0.6, pick: 'task' }).answer, 'task');
  const a = resolve(intent, { probabilities: p(0.7, 0.2, 0.1), confidence: 0.59, pick: 'task' });
  assert.equal(a.abstained, true);
  assert.equal(a.answer, null);
  assert.match(a.reason!, /below floor 0.6/);
  assert.equal(resolve({ ...intent, floor: 0.8 }, { probabilities: p(0.7, 0.2, 0.1), confidence: 0.75 }).abstained, true);
  assert.equal(resolve(intent, { probabilities: p(0.9, 0.05, 0.05) }).answer, 'task', 'no confidence: the pick\'s probability');
});

test('an option\'s own floor is checked on its probability; a runner-up must clear its own', () => {
  const q: Question = { ...intent, floors: { task: 0.95, followup: 0.05 } };
  assert.equal(resolve(q, { probabilities: p(0.96, 0.03, 0.01), confidence: 0.9, pick: 'task' }).answer, 'task');
  const fell = resolve(q, { probabilities: p(0.88, 0.1, 0.02), confidence: 0.85, pick: 'task' });
  assert.equal(fell.answer, 'followup');
  assert.equal(fell.confidence, 0.1);
  assert.match(fell.reason!, /fell to followup/);
  // chat has no declared floor, so it needs the global 0.6; followup's 0.02 is under its own 0.05.
  assert.equal(resolve(q, { probabilities: p(0.9, 0.02, 0.08), confidence: 0.85, pick: 'task' }).abstained, true);
  const tie = resolve({ ...intent, floors: { task: 0.95, followup: 0.1, chat: 0.1 } }, { probabilities: p(0.5, 0.25, 0.25), confidence: 0.4, pick: 'task' });
  assert.equal(tie.reason, 'runner-up tie');
  // Others without a declared floor need the global 0.6 on their probability to be taken instead.
  assert.equal(resolve({ ...intent, floors: { followup: 0.5 } }, { probabilities: p(0.2, 0.45, 0.35), confidence: 0.3, pick: 'followup' }).abstained, true);
  const shadow: Question = { kind: 'choice', options: Object.fromEntries([['toString', 'Shadow'], ['task', 'Task']]), floors: { task: 0.9 } };
  assert.deepEqual(resolve(shadow, { probabilities: Object.fromEntries([['toString', 0.8], ['task', 0.2]]), confidence: 0.8, pick: 'toString' }).answer, 'toString');
  const fallback: Question = { ...shadow, floors: Object.fromEntries([['toString', 0.95], ['task', 0.1]]) };
  const second = resolve(fallback, { probabilities: Object.fromEntries([['toString', 0.8], ['task', 0.2]]), pick: 'toString' });
  assert.deepEqual([second.answer, second.confidence], ['task', 0.2]);
});

test('a malformed answer or a tie is an abstain, never an error', () => {
  const bad = [
    { probabilities: p(0.5, 0.3, 0.1) },
    { probabilities: { task: 0.9, followup: 0.1 } },
    { probabilities: { ...p(0.9, 0.1, 0), extra: 0 } },
    { probabilities: p(1.2, -0.2, 0) },
    { probabilities: p(0.9, 0.1, 0), pick: 'nope' },
    { probabilities: p(0.9, 0.1, 0), confidence: 2 },
    { probabilities: { task: '0.9', followup: 0.1, chat: 0 } as never },
  ];
  for (const r of bad) assert.equal(resolve(intent, r).reason, 'malformed answer', JSON.stringify(r));
  assert.equal(resolve(intent, undefined).reason, 'no answer');
  assert.equal(resolve(intent, { probabilities: p(0.45, 0.45, 0.1), confidence: 0.9 }).reason, 'tie');
});

test('yes/no and score answers are typed', () => {
  const yes: Question = { kind: 'yesno', question: 'Does this spend money?' };
  assert.equal(resolve(yes, { probabilities: { true: 0.9, false: 0.1 } }).answer, true);
  assert.equal(resolve(yes, { probabilities: { true: 0.2, false: 0.8 } }).answer, false);
  assert.equal(resolve(yes, { probabilities: { true: 0.55, false: 0.45 } }).abstained, true);
  const score: Question = { kind: 'score', levels: ['fine', 'rough', 'unusable'] };
  assert.equal(resolve(score, { probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 }, confidence: 0.7 }).answer, 1);
});

function mockJev(answers: Record<string, unknown>, calls: Array<{ url: string; init: RequestInit }> = [], status = 200): typeof fetch {
  return async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status });
  };
}

test('jev: the request shape on both routes, the key only in the header, answers mapped back', async () => {
  process.env.TYPESAFE_API_KEY = 'canary-env-key';
  process.env.OPENROUTER_API_KEY = 'canary-env-key';
  try {
    assert.throws(() => jev({ key: '' }), /needs a key/);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = mockJev({
      intent: { type: 'choice', choice: 'followup', confidence: 0.8, probabilities: p(0.1, 0.85, 0.05) },
      spends: { type: 'noul', noul: 0.02 },
      rough: { type: 'score', score: 0.2, confidence: 0.8, probabilities: { 0: 0.8, 1: 0.2 } },
    }, calls);
    const qs: Record<string, Question> = {
      intent,
      spends: { kind: 'yesno', question: 'Does it spend?', yes: 'Money moves', no: 'Nothing is bought' },
      rough: { kind: 'score', levels: ['calm', 'upset'], instructions: 'How upset?' },
    };
    for (const via of ['typesafe', 'openrouter'] as const) {
      const out = await decide({ msg: 'did the plumber call back?' }, qs, { privacy: 'may-leave', backends: [jev({ key: 'host-key', via, fetch: f })] });
      assert.equal(out.intent.answer, 'followup');
      assert.equal(out.spends.answer, false);
      assert.equal(out.rough.answer, 0);
      assert.equal(out.intent.by, 'jev');
    }
    assert.deepEqual(calls.map((c) => c.url), ['https://api.typesafe.ai/v1/systemone', 'https://openrouter.ai/api/v1/systemone']);
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer host-key');
    assert.ok(!JSON.stringify(calls).includes('canary-env-key'), 'never the environment\'s key');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      model: 'jev-latest',
      state: { msg: 'did the plumber call back?' },
      questions: {
        intent: { type: 'choice', instructions: 'Which option fits the state?', criteria: intent.options },
        spends: { type: 'noul', instructions: 'Does it spend?', criteria: { true: 'Money moves', false: 'Nothing is bought' } },
        rough: { type: 'score', instructions: 'How upset?', criteria: ['calm', 'upset'] },
      },
    });
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('decide: privacy skips Jev, rules answer the obvious, a failed or slow Jev abstains without the key', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const j = jev({ key: 'secret-key', fetch: mockJev({ intent: { type: 'choice', choice: 'task', confidence: 0.9, probabilities: p(0.95, 0.03, 0.02) } }, calls) });
  const r = rules((s: { msg: string }) => (/^thanks/i.test(s.msg) ? 'chat' : undefined));

  const priv = await decide({ msg: 'book the dentist' }, { intent }, { privacy: 'stays-here', backends: [r, j] });
  assert.equal(calls.length, 0);
  assert.deepEqual(priv.intent, { answer: null, confidence: 0, abstained: true, reason: 'no answer', by: 'rules', ms: priv.intent.ms, source: 'api' });

  assert.equal((await decide({ msg: 'thanks!' }, { intent }, { privacy: 'may-leave', backends: [r, j] })).intent.by, 'rules');
  assert.equal(calls.length, 0, 'rules answered, Jev never asked');
  const both = await decide({ msg: 'book the dentist' }, { intent }, { privacy: 'may-leave', backends: [r, j] });
  assert.deepEqual([both.intent.answer, both.intent.by, calls.length], ['task', 'jev', 1]);

  const denied = await decide({ msg: 'x' }, { intent }, { privacy: 'may-leave', backends: [jev({ key: 'secret-key', fetch: mockJev({}, [], 401) })] });
  assert.equal(denied.intent.reason, 'jev failed: http 401');
  const hung: typeof fetch = (_u, init) => new Promise((_, no) => init!.signal!.addEventListener('abort', () => no(new Error('timed out'))));
  const slow = await decide({ msg: 'x' }, { intent }, { privacy: 'may-leave', backends: [jev({ key: 'secret-key', fetch: hung }), r], timeoutMs: 20 });
  assert.deepEqual([slow.intent.abstained, slow.intent.reason], [true, 'jev failed: timed out']);
  assert.ok(!JSON.stringify([denied, slow]).includes('secret-key'));
  assert.deepEqual((await decide('x', { intent }, { privacy: 'may-leave', backends: [] })).intent.reason, 'no backend answered');
});

test('a backend ignoring abort cannot answer late or block the next backend', async () => {
  const late = { name: 'late', leaves: false, ask: async () => {
    await new Promise((done) => setTimeout(done, 50));
    return { intent: { probabilities: p(0, 0, 1) } };
  } };
  const next = rules(() => 'task');
  const out = await decide('x', { intent }, { privacy: 'stays-here', backends: [late, next], timeoutMs: 10 });
  assert.deepEqual([out.intent.answer, out.intent.by], ['task', 'rules']);
  const never = { ...late, ask: async () => new Promise<Record<string, never>>(() => {}) };
  const second = await decide('x', { intent }, { privacy: 'stays-here', backends: [never, next], timeoutMs: 10 });
  assert.deepEqual([second.intent.answer, second.intent.by], ['task', 'rules']);
  const entry = new URL('../src/index.ts', import.meta.url).href;
  const script = `import { decide, rules } from ${JSON.stringify(entry)}; const never = { name: 'never', leaves: false, ask: () => new Promise(() => {}) }; const result = await decide('x', { intent: ${JSON.stringify(intent)} }, { privacy: 'stays-here', backends: [never, rules(() => 'task')], timeoutMs: 10 }); console.log(result.intent.answer);`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 }).trim(), 'task');
});

test('decision names that shadow object properties work for rules and Jev', async () => {
  const qs = Object.fromEntries(['toString', '__proto__'].map((k) => [k, intent]));
  const answers = Object.fromEntries(['toString', '__proto__'].map((k) => [k, { choice: 'chat', confidence: 0.9, probabilities: p(0, 0, 1) }]));
  const j = jev({ key: 'host-key', fetch: mockJev(answers) });
  const answered = await decide('x', qs, { privacy: 'may-leave', backends: [rules((_s, k) => k === 'toString' ? 'task' : undefined), j] });
  assert.deepEqual([answered['toString'].answer, answered['__proto__'].answer], ['task', 'chat']);
  const allJev = await decide('x', qs, { privacy: 'may-leave', backends: [j] });
  assert.deepEqual([allJev['toString'].answer, allJev['__proto__'].answer], ['chat', 'chat']);
  assert.deepEqual(Object.keys(answered).sort(), ['__proto__', 'toString']);
});

test('eval: agreement, clear-but-wrong and abstains from recorded answers; the CLI gates on clear-but-wrong', async () => {
  const path = new URL('../evals/example-urgent.jsonl', import.meta.url).pathname;
  const f = parse(readFileSync(path, 'utf8'));
  assert.equal(format(f), readFileSync(path, 'utf8'), 'format round-trips the file');
  const r = await evaluate(f.cases, replay(f.question));
  assert.deepEqual([r.cases, r.agree, r.clearWrong, r.abstained], [5, 4, 0, 1]);
  assert.deepEqual(r.ms, { min: 165, median: 180, max: 201 });

  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  assert.match(execFileSync(process.execPath, [cli, path], { encoding: 'utf8' }), /agree 4\/5 {3}clear-but-wrong 0 \(0%\) {3}abstained 1 \(20%\)/);
  const wrong = join(scratchDir('eval'), 'wrong.jsonl');
  writeFileSync(wrong, format({ ...f, cases: [{ state: 'x', expect: false, jev: { type: 'noul', noul: 0.9 } }] }));
  const run = spawnSync(process.execPath, [cli, wrong], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /wrong: line 2 expected false, got true at 0.9/);
  const live = spawnSync(process.execPath, [cli, wrong, '--live', 'typesafe'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(live.status, 2, 'no key, no live run');
  for (const flag of ['--floor', '--max-clear-wrong']) {
    for (const value of ['nope', 'Infinity', '-0.1', '1.1', '']) {
      assert.equal(spawnSync(process.execPath, [cli, wrong, flag, value], { encoding: 'utf8' }).status, 2, `${flag} ${value}`);
    }
  }
});

test('eval counts expected abstention as agreement without changing abstention count', async () => {
  const q: Question = { kind: 'yesno', question: 'Urgent?' };
  const cases = [
    { state: 'unclear', expect: null, jev: { type: 'noul', noul: 0.5 } },
    { state: 'also unclear', expect: false, jev: { type: 'noul', noul: 0.5 } },
  ];
  const r = await evaluate(cases, replay(q));
  assert.deepEqual([r.cases, r.agree, r.abstained, r.clearWrong], [2, 1, 2, 0]);
  assert.match(summary('urgent', 'recorded', r), /agree 1\/2 {3}clear-but-wrong 0 \(0%\) {3}abstained 2 \(100%\)/);
});

test('live recording preserves failed cases and labels partial refresh', () => {
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const path = join(scratchDir('record'), 'answers.jsonl');
  const question: Question = { kind: 'yesno', question: 'Urgent?' };
  const old = { type: 'noul', noul: 0.9 };
  writeFileSync(path, format({ decision: 'urgent', question, note: 'hand-made, not recorded', cases: [
    { state: 'fail', expect: true, jev: old, ms: 42 },
    { state: 'ok', expect: false, jev: old, ms: 43 },
  ] }));
  const before = readFileSync(path, 'utf8');
  const env = { PATH: process.env.PATH, TYPESAFE_API_KEY: 'test-key' };
  const fail = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = async () => new Response("", { status: 401 })');
  spawnSync(process.execPath, ['--import', fail, cli, path, '--live', 'typesafe', '--record'], { env, encoding: 'utf8' });
  assert.equal(readFileSync(path, 'utf8'), before);
  const partial = 'data:text/javascript,' + encodeURIComponent(`let n = 0; globalThis.fetch = async () => n++ ? new Response(JSON.stringify({answers:{urgent:{type:'noul',noul:0.1}}})) : new Response('', {status:401})`);
  const run = spawnSync(process.execPath, ['--import', partial, cli, path, '--live', 'typesafe', '--record'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0);
  const f = parse(readFileSync(path, 'utf8'));
  assert.deepEqual([f.cases[0].jev, f.cases[0].ms], [old, 42]);
  assert.deepEqual(f.cases[1].jev, { type: 'noul', noul: 0.1 });
  assert.match(f.note!, /partial live refresh 1\/2.*hand-made, not recorded/);
});

test('answers carry usage and the raw response, even when abstaining on a malformed answer', async () => {
  const body = { model: 'jev-1.13.0', answers: {
    intent: { type: 'choice', choice: 'task', confidence: 0.9, probabilities: p(0.95, 0.03, 0.02) },
    broken: { type: 'choice', choice: 'task', confidence: 'high', probabilities: p(0.9, 0.05, 0.05) },
  }, usage: { input_tokens: 7, output_tokens: 3 } };
  const f: typeof fetch = async () => new Response(JSON.stringify(body));
  const out = await decide('x', { intent, broken: intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: f })] });
  assert.deepEqual(out.intent.usage, { input_tokens: 7, output_tokens: 3 });
  assert.deepEqual(out.intent.raw, body);
  assert.equal(out.intent.source, 'api');
  assert.deepEqual([out.broken.abstained, out.broken.reason], [true, 'malformed answer']);
  assert.deepEqual(out.broken.usage, { input_tokens: 7, output_tokens: 3 }, 'a failed answer keeps its usage');
  assert.deepEqual(out.broken.raw, body, 'a failed answer keeps its raw response');
});

test('usage is absent, never invented, when the backend sends none; invalid counts are ignored', async () => {
  const noUsage: typeof fetch = async () => new Response(JSON.stringify({ answers: {
    intent: { type: 'choice', choice: 'chat', confidence: 0.9, probabilities: p(0, 0, 1) },
  } }));
  const out = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: noUsage })] });
  assert.equal(out.intent.usage, undefined);
  assert.ok(out.intent.raw, 'the raw response is still there');
  const badUsage: typeof fetch = async () => new Response(JSON.stringify({ answers: {
    intent: { type: 'choice', choice: 'chat', confidence: 0.9, probabilities: p(0, 0, 1) },
  }, usage: { input_tokens: -2, output_tokens: 'lots' } }));
  const bad = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: badUsage })] });
  assert.equal(bad.intent.usage, undefined);
  assert.equal(bad.intent.answer, 'chat', 'a bad usage block never fails the answer');
});

test('cacheKey is a stable sha256 of the canonical body', () => {
  const a = cacheKey({ b: 1, a: 2 }, { intent });
  const b = cacheKey({ a: 2, b: 1 }, { intent });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, cacheKey({ a: 2, b: 3 }, { intent }));
  assert.notEqual(a, cacheKey({ b: 1, a: 2 }, { other: intent }));
  const canonical = '{"questions":{"intent":{"kind":"choice","options":{"chat":"Just talk","followup":"About an earlier job","task":"A new job"}}}'
    + ',"state":{"a":2,"b":1}}';
  assert.equal(a, createHash('sha256').update(canonical).digest('hex'), 'the pure-TS sha256 matches Node crypto');
});

test('cache: a miss asks live and stores; a hit serves the same usage/raw with no backend call', async () => {
  let calls = 0;
  const f: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ model: 'jev-1.13.0',
      answers: { intent: { type: 'choice', choice: 'task', confidence: 0.9, probabilities: p(0.95, 0.03, 0.02) } },
      usage: { input_tokens: 11, output_tokens: 5 } }));
  };
  const cache = new MemoryCache();
  const backend = () => jev({ key: 'k', fetch: f });
  const first = await decide({ msg: 'hi' }, { intent }, { privacy: 'may-leave', backends: [backend()], cache });
  assert.deepEqual([first.intent.answer, first.intent.source, calls, cache.size], ['task', 'api', 1, 1]);
  const second = await decide({ msg: 'hi' }, { intent }, { privacy: 'may-leave', backends: [backend()], cache });
  assert.deepEqual([second.intent.answer, second.intent.source, calls], ['task', 'cache', 1]);
  assert.deepEqual(second.intent.usage, first.intent.usage);
  assert.deepEqual(second.intent.raw, first.intent.raw);
  const other = await decide({ msg: 'bye' }, { intent }, { privacy: 'may-leave', backends: [backend()], cache });
  assert.deepEqual([other.intent.source, calls], ['api', 2], 'a different state misses');
});

test('cache accepts an async implementation, and a broken cache never fails a decision', async () => {
  const store = new Map<string, Record<string, never>>();
  const asyncCache = {
    get: async (k: string) => store.get(k) as never,
    set: async (k: string, v: Record<string, never>) => { store.set(k, v); },
  };
  const f: typeof fetch = async () => new Response(JSON.stringify({ answers: {
    intent: { type: 'choice', choice: 'chat', confidence: 0.9, probabilities: p(0, 0, 1) } } }));
  const once = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: f })], cache: asyncCache });
  const twice = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: () => { throw new Error('must not be called'); } })], cache: asyncCache });
  assert.deepEqual([once.intent.source, twice.intent.source, twice.intent.answer], ['api', 'cache', 'chat']);
  const broken = { get: async () => { throw new Error('disk gone'); }, set: async () => { throw new Error('disk gone'); } };
  const live = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: f })], cache: broken });
  assert.deepEqual([live.intent.answer, live.intent.source], ['chat', 'api']);
});

test('jev retries a 429 then succeeds; other statuses never retry', async () => {
  let calls = 0;
  const flaky: typeof fetch = async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0.01' } });
    return new Response(JSON.stringify({ answers: {
      intent: { type: 'choice', choice: 'task', confidence: 0.9, probabilities: p(0.95, 0.03, 0.02) } } }));
  };
  const out = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: flaky, retryMaxMs: 1000 })] });
  assert.deepEqual([out.intent.answer, calls], ['task', 2]);
  for (const status of [400, 401, 403, 404, 500]) {
    let n = 0;
    const f: typeof fetch = async () => { n++; return new Response('', { status }); };
    const r = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: f, retryBaseMs: 1 })] });
    assert.deepEqual([r.intent.reason, n], [`jev failed: http ${status}`, 1], `no retry on ${status}`);
  }
});

test('an exhausted 429 reports http 429 after 1 + maxRetries calls', async () => {
  let calls = 0;
  const limited: typeof fetch = async () => { calls++; return new Response('', { status: 429 }); };
  const r = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: limited, maxRetries: 1, retryBaseMs: 1 })] });
  assert.deepEqual([r.intent.reason, calls], ['jev failed: http 429', 2]);
});

test('Retry-After is honoured, and a huge one is capped by retryMaxMs', async () => {
  const honoured = async (retryAfter: string, maxMs: number) => {
    let calls = 0;
    const f: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': retryAfter } });
      return new Response(JSON.stringify({ answers: {
        intent: { type: 'choice', choice: 'chat', confidence: 0.9, probabilities: p(0, 0, 1) } } }));
    };
    const t0 = Date.now();
    const r = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: f, retryMaxMs: maxMs })] });
    return { ms: Date.now() - t0, answer: r.intent.answer, calls };
  };
  const waited = await honoured('0.05', 5000);
  assert.deepEqual([waited.answer, waited.calls], ['chat', 2]);
  assert.ok(waited.ms >= 30 && waited.ms < 5000, `honoured ~50 ms, took ${waited.ms} ms`);
  const capped = await honoured('120', 20);
  assert.deepEqual([capped.answer, capped.calls], ['chat', 2]);
  assert.ok(capped.ms < 5000, `a 120 s Retry-After was capped, took ${capped.ms} ms`);
});

test('an abort during backoff settles promptly without another call', async () => {
  let calls = 0;
  const f: typeof fetch = async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '30' } }); };
  const t0 = Date.now();
  const r = await decide('x', { intent }, { privacy: 'may-leave', backends: [jev({ key: 'k', fetch: f, retryMaxMs: 60000 })], timeoutMs: 30 });
  const ms = Date.now() - t0;
  assert.equal(r.intent.abstained, true);
  assert.match(r.intent.reason!, /abort|timed out/i);
  assert.equal(calls, 1);
  assert.ok(ms < 5000, `backoff aborted instead of waiting 30 s, took ${ms} ms`);
});

// Saved API-shape fixtures are hand-authored from official Responses documentation, not live recordings.
test('OpenAI structured responses produce typed answers with self-reported confidence and usage/raw', async () => {
  const { openai, OPENAI_ROUTES } = await import('../src/index.ts');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/openai-responses.json', import.meta.url), 'utf8'));
  const questions: Record<string, Question> = { intent, urgent: { kind: 'yesno', question: 'Urgent?' },
    rating: { kind: 'score', levels: ['low', 'medium', 'high'] } };
  let sent: any;
  const backend = openai({ key: 'test-key', model: 'gpt-6.1-sol', request: { reasoning: { effort: 'low' },
    max_output_tokens: 1024, text: { verbosity: 'low' }, instructions: 'Use the supplied rubric.' },
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal((init!.headers as any).authorization, 'Bearer test-key');
      sent = JSON.parse(init!.body as string);
      return Response.json(fixture.completed);
    } });
  const raw = await backend.ask({ text: 'please check the plumber today' }, questions, new AbortController().signal);
  assert.equal(raw.intent?.confidence, undefined, 'no native confidence invented');
  const result = await decide({}, questions, { privacy: 'may-leave', backends: [backend] });
  assert.deepEqual([result.intent.answer, result.urgent.answer, result.rating.answer], ['followup', true, 2]);
  assert.equal(result.intent.confidence, 0.8);
  assert.equal(result.intent.confidenceSource, 'self-reported');
  for (const a of Object.values(result)) {
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, fixture.completed);
  }
  assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.equal(sent.max_output_tokens, 1024);
  assert.equal(sent.text.verbosity, 'low');
  assert.match(sent.instructions, /Use the supplied rubric/);
  assert.equal(sent.text.format.strict, true);
  const shape = sent.text.format.schema.properties;
  assert.deepEqual(shape.urgent.properties.probabilities.required, ['true', 'false']);
  assert.deepEqual(shape.rating.properties.pick.enum, ['0', '1', '2']);
  assert.deepEqual(shape.intent.properties.probabilities.required, ['task', 'followup', 'chat']);
  assert.deepEqual(OPENAI_ROUTES.apiKey, { billing: 'api', offer: false });
});

test('OpenAI refuses, incomplete, malformed, missing and uncertain replies abstain with usage/raw intact', async () => {
  const { openai } = await import('../src/index.ts');
  const f = JSON.parse(readFileSync(new URL('./fixtures/openai-responses.json', import.meta.url), 'utf8'));
  const textResponse = (text: string) => ({ ...f.completed, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
  const cases = [f.refusal, f.incomplete, textResponse('not json'), textResponse('{}'),
    textResponse(JSON.stringify({ intent: { probabilities: p(0.5, 0.5, 0), pick: 'task' } })),
    textResponse(JSON.stringify({ intent: { probabilities: p(0.5, 0.3, 0.2), pick: 'task' } })),
    textResponse(JSON.stringify({ intent: { probabilities: p(0.9, 0.1, -1), pick: 'task' } }))];
  for (const response of cases) {
    const a: Answer = (await decide({}, { intent }, { privacy: 'may-leave', backends: [openai({ key: 'fake', model: 'gpt-6.1-sol',
      fetch: async () => Response.json(response) })] })).intent;
    assert.equal(a.abstained, true);
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, response);
    assert.equal(a.confidenceSource, 'self-reported');
  }
  let calls = 0;
  const backend = openai({ key: 'fake', model: 'gpt-6.1-sol', fetch: async () => { calls++; return Response.json(f.completed); } });
  await decide({}, { intent }, { privacy: 'stays-here', backends: [backend] });
  assert.equal(calls, 0);
});

test('OpenAI and Jev share bounded 429 retry and abort behavior; other statuses never retry', async () => {
  const { openai } = await import('../src/index.ts');
  const f = JSON.parse(readFileSync(new URL('./fixtures/openai-responses.json', import.meta.url), 'utf8'));
  let calls = 0;
  const backend = openai({ key: 'fake', model: 'gpt-6.1-sol', maxRetries: 2, retryMaxMs: 1,
    fetch: async () => { calls++; return calls < 3 ? new Response('', { status: 429, headers: { 'Retry-After': '1000' } }) : Response.json(f.completed); } });
  assert.equal((await decide({}, { intent }, { privacy: 'may-leave', backends: [backend] })).intent.answer, 'followup');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(openai({ key: 'fake', model: 'gpt-6.1-sol', fetch: async () => { calls++; return new Response('', { status: 401 }); } })
    .ask({}, { intent }, new AbortController().signal), /http 401/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  const waiting = openai({ key: 'fake', model: 'gpt-6.1-sol', retryBaseMs: 500, fetch: async () => {
    controller.abort(new Error('cancelled')); return new Response('', { status: 429 });
  } });
  await assert.rejects(waiting.ask({}, { intent }, controller.signal), /cancelled/);
});

test('official account route checks consent/catalogue, consumes completed SSE and never bills an API key', async () => {
  const { openai, UnsupportedAccountError } = await import('../src/index.ts');
  const { chatgptPlan } = await import('@byokit/accounts/chatgpt-plan');
  const f = JSON.parse(readFileSync(new URL('./fixtures/openai-responses.json', import.meta.url), 'utf8'));
  const scopes = ['resource.invoke', 'chatgpt.tokens.use.direct'];
  let granted = scopes;
  let visible = true;
  let terminal = true;
  let calls = 0;
  let sent: any;
  const account = chatgptPlan({ session: async () => ({ accessToken: 'plan-token', scopes: granted }) });
  const backend = openai({ auth: 'account', account, model: 'gpt-6.1-sol', fetch: async (url, init) => {
    calls++;
    assert.equal((init!.headers as any).authorization, 'Bearer plan-token');
    if (url === 'https://api.openai.com/v1/models') return Response.json({ models: visible ? [{ slug: 'gpt-6.1-sol', visibility: 'list' }] : [] });
    assert.equal(url, 'https://api.openai.com/v1/responses');
    sent = JSON.parse(init!.body as string);
    const events = [{ type: 'response.output_text.delta', delta: '{"intent":' },
      ...(terminal ? [{ type: 'response.completed', response: f.completed }] : [])];
    const bytes = new TextEncoder().encode(events.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }));
  } });
  const result = (await decide({}, { intent }, { privacy: 'may-leave', backends: [backend] })).intent;
  assert.equal(result.answer, 'followup');
  assert.deepEqual(result.raw, f.completed);
  assert.deepEqual(result.usage, { input_tokens: 84, output_tokens: 67 });
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.equal(Array.isArray(sent.input), true);
  terminal = false;
  assert.equal((await decide({}, { intent }, { privacy: 'may-leave', backends: [backend] })).intent.abstained, true, 'deltas cannot prove completion');
  visible = false;
  await assert.rejects(decide({}, { intent }, { privacy: 'may-leave', backends: [backend] }), UnsupportedAccountError);
  const before = calls;
  granted = ['openid'];
  await assert.rejects(decide({}, { intent }, { privacy: 'may-leave', backends: [backend] }), UnsupportedAccountError);
  assert.equal(calls, before, 'no consent: no fetch, no API fallback');
  assert.throws(() => openai({ auth: 'account', account, model: 'gpt-6.1-sol', request: { max_output_tokens: 128 } }), UnsupportedAccountError);
});

test('plain config sets a backend once, per-call overrides isolate cache by provider/model/auth/person', async () => {
  const { parseConfig, createDecider, ConfigError, UnsupportedAccountError } = await import('../src/index.ts');
  const { chatgptPlan } = await import('@byokit/accounts/chatgpt-plan');
  const f = JSON.parse(readFileSync(new URL('./fixtures/openai-responses.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseConfig(), { backend: 'jev', auth: 'apiKey' });
  assert.deepEqual(parseConfig('{"backend":"openai","model":"gpt-6.1-sol"}'), { backend: 'openai', auth: 'apiKey', model: 'gpt-6.1-sol' });
  for (const bad of ['{', [], { backend: 'other' }, { backend: 'openai' }, { auth: 'token' }, { unexpected: 1 }, { maxRetries: -1 },
    { backend: 'openai', model: 'gpt-6.1-sol', request: { input: 'override' } }]) assert.throws(() => parseConfig(bad), ConfigError);
  assert.throws(() => parseConfig({ backend: 'jev', auth: 'account' }), UnsupportedAccountError);
  let calls = 0;
  const config = parseConfig({ backend: 'openai', model: 'gpt-6.1-sol' });
  const cache = new MemoryCache();
  const run = createDecider(config, { privacy: 'may-leave', cache, host: { keys: { openai: 'openai-key', jev: 'jev-key' },
    fetch: async (url, init) => {
      calls++;
      if (String(url).endsWith('/systemone')) {
        assert.equal((init!.headers as any).authorization, 'Bearer jev-key');
        return Response.json({ answers: { intent: { choice: 'task', probabilities: p(0.9, 0.1, 0), confidence: 0.9 } }, usage: { input_tokens: 2, output_tokens: 1 } });
      }
      return Response.json(f.completed);
    } } });
  assert.equal((await run({}, { intent })).intent.source, 'api');
  const hit = (await run({}, { intent })).intent;
  assert.equal(hit.source, 'cache');
  assert.deepEqual(hit.raw, f.completed);
  assert.deepEqual(hit.usage, { input_tokens: 84, output_tokens: 67 });
  assert.equal(calls, 1);
  assert.equal((await run({}, { intent }, { backend: 'jev' })).intent.answer, 'task');
  assert.equal(calls, 2, 'backend switch bypasses the other backend cache');
  await run({}, { intent }, { model: 'a-different-model' });
  assert.equal(calls, 3);
  const otherPerson = createDecider(config, { privacy: 'may-leave', cache, host: { keys: { openai: 'other-person-key' },
    cacheScope: 'other-person', fetch: async () => { calls++; return Response.json(f.completed); } } });
  assert.equal((await otherPerson({}, { intent })).intent.source, 'api');
  assert.equal(calls, 4, 'another credential/person cannot reuse the first person cache');
  assert.throws(() => createDecider({ backend: 'jev' }, { privacy: 'may-leave', host: {} })({}, { intent }, { backend: 'openai' }), ConfigError);
  const account = chatgptPlan({ session: async () => ({ accessToken: 'fake', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] }) });
  await assert.rejects(decide({}, { intent }, { config: parseConfig({ backend: 'openai', auth: 'account', model: 'gpt-6.1-sol' }),
    privacy: 'may-leave', cache, host: { account } }), ConfigError);
});
