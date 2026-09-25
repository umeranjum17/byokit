// The floors, the backends and the eval runner, with a mocked Jev: no key, no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { join } from 'node:path';
import { decide, jev, resolve, rules, type Question } from '../src/index.ts';
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
  assert.deepEqual(priv.intent, { answer: null, confidence: 0, abstained: true, reason: 'no answer', by: 'rules', ms: priv.intent.ms });

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
