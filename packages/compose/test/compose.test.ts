// BK-P1 (docs/capability-kits.md 4.4): the version gate, validation before the engine, answers and no-state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compose } from '../src/compose.ts';
import { ComposeError } from '../src/errors.ts';
import { fakeEngine } from '../src/testing/fake-engine.ts';
import type { Engine, Rules } from '../src/types.ts';

const RULES: Rules = { never: ['delve'], noDashes: true, statementEndings: false, note: '' };

test('hello memoizes: later calls send no new request', async () => {
  const fake = fakeEngine({ version: '1.2.3' });
  const compose = new Compose({ engine: fake });
  assert.deepEqual(await compose.hello(), { protocol: 1, version: '1.2.3' });
  assert.deepEqual(await compose.hello(), { protocol: 1, version: '1.2.3' });
  await compose.platforms();
  assert.deepEqual(fake.requests.map((request) => request.verb), ['hello', 'platforms']);
});

test('every verb reaches the engine with its params', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  await compose.voice.parse('## Never say\n- delve\n');
  await compose.voice.guide(RULES, { post: true });
  await compose.voice.guide(RULES);
  await compose.brief({ kind: 'reply', platform: 'x', rules: RULES });
  await compose.check({ drafts: ['hi'], platform: 'x', rules: RULES, original: 'yo' });
  await compose.split({ text: 'hi. yo.', platform: 'x' });
  assert.deepEqual(fake.requests.map((request) => request.verb), [
    'hello', 'voice.parse', 'voice.guide', 'voice.guide', 'brief', 'check', 'split',
  ]);
  assert.deepEqual(fake.requests[2]?.params, { rules: RULES, post: true });
  assert.deepEqual(fake.requests[3]?.params, { rules: RULES, post: false }, 'post defaults to false');
});

test('an out-of-range protocol fails the first call and every later one, closed', async () => {
  for (const protocol of [2, 0]) {
    const fake = fakeEngine({ protocol });
    const compose = new Compose({ engine: fake });
    const first = await compose.brief({ kind: 'post', platform: 'x' }).then(() => null, (e: unknown) => e);
    assert.ok(first instanceof ComposeError && first.code === 'needs-update');
    assert.deepEqual(first.detail, { protocol });
    const hello = await compose.hello().then(() => null, (e: unknown) => e);
    assert.ok(hello instanceof ComposeError && hello.code === 'needs-update', 'hello itself also rejects');
    assert.deepEqual(fake.requests.map((request) => request.verb), ['hello'], `protocol ${protocol} saw only hello`);
  }
});

test('an engine error envelope rejects with its code', async () => {
  const fake = fakeEngine({ fail: { verb: 'split', code: 'too-long', message: 'way too long' } });
  const compose = new Compose({ engine: fake });
  const error = await compose.split({ text: 'hi', platform: 'x' }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ComposeError && error.code === 'engine');
  assert.equal(error.message, 'way too long');
  assert.deepEqual(error.detail, { engineCode: 'too-long' });
});

test('a result outside the 4.3 shapes rejects as an engine failure', async () => {
  const engine: Engine = { handle: async () => ({ lines: 'not an array' }) };
  const compose = new Compose({ engine });
  const error = await compose.brief({ kind: 'reply', platform: 'x' }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ComposeError && error.code === 'engine');
  assert.equal(error.message, 'engine answered an unexpected shape');
});

test('a check with the wrong draft count rejects as an engine failure', async () => {
  const engine: Engine = { handle: async () => [] };
  const compose = new Compose({ engine });
  const error = await compose.check({ drafts: ['a'], platform: 'x' }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ComposeError && error.code === 'engine');
});

test('invalid input rejects before the engine', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  const calls: Array<() => Promise<unknown>> = [
    () => compose.voice.parse(42 as never),
    () => compose.voice.parse('bad\0markdown'),
    () => compose.voice.parse('x'.repeat(100_001)),
    () => compose.voice.guide({ never: 'delve', noDashes: true, statementEndings: false, note: '' } as never),
    () => compose.voice.guide({ never: [], noDashes: 1 as never, statementEndings: false, note: '' }),
    () => compose.voice.guide({ never: [], noDashes: false, statementEndings: false, note: 'n'.repeat(201) }),
    () => compose.brief({ kind: 'email' as never, platform: 'x' }),
    () => compose.brief({ kind: 'reply', platform: '' }),
    () => compose.check({ drafts: [], platform: 'x' }),
    () => compose.check({ drafts: Array(51).fill('hi'), platform: 'x' }),
    () => compose.check({ drafts: ['ok', 7 as never], platform: 'x' }),
    () => compose.check({ drafts: ['hi'], platform: 'x', original: 'n'.repeat(100_001) }),
    () => compose.split({ text: 'hi', platform: 7 as never }),
  ];
  for (const call of calls) {
    const error = await call().then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ComposeError && error.code === 'invalid', `got ${String(error)}`);
  }
  assert.deepEqual(fake.requests, [], 'validation runs before any engine request, hello included');
});
