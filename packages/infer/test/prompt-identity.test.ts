// Prompt-identity logging: real summarizePane + real PromptIdentityLog, fake llama transport only.
// Runnable with no device: `node --test packages/infer/test/prompt-identity.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LocalModel, summarizePane, paneText, model, promptHash, samePromptIdentity, commonPrefixLength, PromptIdentityLog,
  type InferModel } from '../src/index.ts';
import { fakeLlama, memoryModelStore } from '../src/testing.ts';

const BYTES = new TextEncoder().encode('GGUF fake weights');
const REV = 'a'.repeat(40);
const TINY: InferModel = { ...model(), id: 'tiny', revision: REV, file: 'tiny.gguf',
  url: `https://example.test/r/${REV}/tiny.gguf`, bytes: BYTES.byteLength, sha256: createHash('sha256').update(BYTES).digest('hex') };
const OK = () => JSON.stringify({ enough: true, lines: ['Running the accounts tests.', '41 passed, 1 failed: login refresh.', 'Login refresh is next.'] });
const PANE_A = ['$ npm test', 'running 42 tests in packages/accounts', 'ok 41 tests passed', 'not ok 1 - login refresh keeps the account'];
const PANE_B = ['$ npm test', 'running 42 tests in packages/accounts', 'ok 42 tests passed', 'all green, packing the release now'];

async function local() {
  const llama = fakeLlama({ reply: OK });
  const mem = memoryModelStore({ [TINY.url]: BYTES });
  const m = new LocalModel({ model: TINY, store: mem.store, initLlama: llama.initLlama });
  await m.install();
  return m;
}

test('two identical prompts then a changed one: consecutive-identical 1, changed 2', async () => {
  const m = await local();
  const log = new PromptIdentityLog();
  for (const pane of [PANE_A, PANE_A, PANE_B]) assert.equal((await summarizePane(m, pane, { identity: { tracker: log } })).ok, true);
  assert.deepEqual(log.counts, { total: 3, consecutiveIdentical: 1, identicalNonConsecutive: 0, changed: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(log.counts)), log.counts, 'counts are plain bench-readable JSON');
});

test('a repeat after a different prompt counts as identical-non-consecutive', async () => {
  const m = await local();
  const log = new PromptIdentityLog();
  for (const pane of [PANE_A, PANE_B, PANE_A]) await summarizePane(m, pane, { identity: { tracker: log } });
  assert.deepEqual(log.counts, { total: 3, consecutiveIdentical: 0, identicalNonConsecutive: 1, changed: 2 });
});

test('off by default: no tracker, no callback, no behaviour change', async () => {
  const m = await local();
  let calls = 0;
  const s = await summarizePane(m, PANE_A);
  assert.equal(s.ok, true);
  assert.equal(calls, 0);
  const seen: unknown[] = [];
  await summarizePane(m, PANE_A, { identity: { onIdentity: id => { calls++; seen.push(id); } } });
  assert.equal(calls, 1);
  assert.match(JSON.stringify(seen[0]), /"inputTokens":\d+/);
});

test('the identity is a hash plus a token count: stable, content-free, engine-relative', () => {
  const a = promptHash('x'.repeat(100)), b = promptHash('x'.repeat(100)), c = promptHash('y'.repeat(100));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes('npm') && !c.includes('accounts'), 'no pane text survives in the hash');
  assert.equal(samePromptIdentity({ inputTokens: 1010, hash: a }, { inputTokens: 1010, hash: a }), true);
  assert.equal(samePromptIdentity({ inputTokens: 1010, hash: a }, { inputTokens: 1002, hash: a }), false,
    'same text, different engine token counts (GGUF vs Nano): not identical');
  assert.equal(samePromptIdentity({ inputTokens: 1010, hash: a }, { inputTokens: 1010, hash: c }), false);
});

test('a growing pane shares its whole previous prompt as a prefix; a scrolled pane does not', () => {
  const first = paneText(PANE_A).join('\n');
  const grown = paneText([...PANE_A, 'ok 42 tests passed']).join('\n');
  assert.equal(commonPrefixLength(first, grown), first.length, 'append keeps every previous byte: the reusable-prefix upper bound');
  const scrolled = paneText([...Array.from({ length: 200 }, (_, i) => `line ${i} of the build log output`), 'tail line here']).join('\n');
  const earlier = paneText(Array.from({ length: 200 }, (_, i) => `line ${i} of the build log output`)).join('\n');
  assert.ok(commonPrefixLength(earlier, scrolled) < earlier.length, 'lines dropped off the cap break the prefix');
});
