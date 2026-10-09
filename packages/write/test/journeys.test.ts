// Consumer journeys for the published @byokit/write surface, driven the way an app uses it through the built
// package (`@byokit/write` and `@byokit/write/testing`): draft in a person's voice over the pinned writing
// engine, read the sentences a person sees, and stay safe when the engine is wrong or the input is bad.
// Every security and correctness contract the old unit and fake-upstream cases held survives as an assertion
// here: the version gate fails closed after hello alone, invalid input never reaches the engine, an engine
// error keeps its code and leaves the other verbs answering, a null limit always fits and never splits, the
// frozen words table is verbatim, plain and makes no claim about where a draft goes. The fake engine is the
// kit's own published testing aid; no network, key or live model is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Compose, ComposeError, checkLines, words,
  type DraftCheck, type Engine, type Platform, type Rules, type WordKey,
} from '@byokit/write';
import { fakeEngine } from '@byokit/write/testing';

const SLOTS = [
  'Agree and add one concrete detail.',
  'Push back kindly, with one reason.',
  'Ask one sharp question.',
];
const RULES: Rules = { never: ['delve'], noDashes: false, statementEndings: false, note: '' };

test("an app drafts in a person's voice over the built kit: platforms, voice, brief, check and split", async () => {
  const writer = new Compose({ engine: fakeEngine() });

  const platforms = await writer.platforms();
  assert.deepEqual(platforms.map((platform) => [platform.id, platform.limit, platform.kind]), [
    ['x', 280, 'feed'], ['linkedin', 3000, 'feed'], ['reddit', 10000, 'feed'],
    ['slack', 40000, 'chat'], ['whatsapp', 65536, 'chat'], ['gmail', null, 'mail'],
  ]);
  for (const platform of platforms) assert.deepEqual(platform.slots, SLOTS);
  assert.equal(platforms.find((platform) => platform.id === 'x')?.polish, 'The first line must stand alone.');
  assert.equal(platforms.find((platform) => platform.id === 'gmail')?.polish, '');

  const parsed = await writer.voice.parse('## Never say\n- delve\n- "game changer"\n');
  assert.deepEqual(parsed.rules.never, ['delve', 'game changer']);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.rules.noDashes, false);
  const dashes = await writer.voice.parse('# Voice\nWe avoid the em dash here.\n## Never say\n- seamless\n');
  assert.equal(dashes.rules.noDashes, true);
  assert.deepEqual(dashes.rules.never, ['seamless']);
  const outside = await writer.voice.parse('- delve\n# Later\nSome text.\n');
  assert.deepEqual(outside.rules.never, [], 'bullets outside a never-say heading do not count');
  const long = await writer.voice.parse(`## Never say\n- ${'w'.repeat(201)}\n- ok\n`);
  assert.deepEqual(long.rules.never, ['ok']);
  assert.equal(long.skipped, 1);

  assert.equal(await writer.voice.guide({ never: [], noDashes: true, statementEndings: false, note: '' }), 'No em dashes.');
  assert.equal(
    await writer.voice.guide({ never: [], noDashes: true, statementEndings: true, note: 'Short lines.' }, { post: true }),
    'No em dashes. End on a statement, not a question. How they write: Short lines.',
  );
  assert.equal(
    await writer.voice.guide({ never: [], noDashes: false, statementEndings: true, note: '' }),
    '',
    'the statement rule is for posts only',
  );

  assert.deepEqual(await writer.brief({ kind: 'reply', platform: 'x' }), SLOTS);
  assert.deepEqual(await writer.brief({ kind: 'polish', platform: 'x' }), ['The first line must stand alone.']);
  assert.deepEqual(await writer.brief({ kind: 'polish', platform: 'gmail' }), [], 'no polish rule means no lines');
  assert.deepEqual(await writer.brief({ kind: 'post', platform: 'linkedin' }), ['One post for LinkedIn.']);
  assert.deepEqual(await writer.brief({ kind: 'thread', platform: 'reddit' }), ['One post for Reddit.']);

  const draft = 'Lets delve in at 3pm, 50 seats.';
  const [checked] = await writer.check({ drafts: [draft], platform: 'x', rules: RULES, original: 'Lets meet at 3pm, 40 seats.' });
  assert.ok(checked !== undefined);
  assert.equal(checked.length, draft.length, 'length is measured in UTF-16 units');
  assert.equal(checked.limit, 280);
  assert.equal(checked.fits, true);
  assert.deepEqual(checked.voice, ['says “delve” from your never-say list']);
  assert.deepEqual(checked.stock, ['delve']);
  assert.deepEqual(checked.added, ['50']);
  assert.deepEqual(checked.dropped, ['40']);
  assert.equal(checked.layoutKept, true);
  assert.equal(checked.words, 'A bit stock');
  const [clean] = await writer.check({ drafts: ['Hello there.'], platform: 'gmail' });
  assert.ok(clean !== undefined);
  assert.equal(clean.fits, true, 'a null limit always fits');
  assert.equal(clean.words, 'Sounds natural');
  const [lists] = await writer.check({ drafts: ['- one\n- two\n'], platform: 'x', original: 'Just words.\n' });
  assert.ok(lists !== undefined);
  assert.equal(lists.layoutKept, false, 'a changed list count breaks the layout');

  const posts = await writer.split({ text: Array(30).fill('All systems go now.').join(' '), platform: 'x' });
  assert.ok(posts.length > 1);
  for (const post of posts) assert.ok(post.length <= 280);
  const hard = `First. ${'w'.repeat(300)}. Last.`;
  const wrapped = await writer.split({ text: hard, platform: 'x' });
  for (const post of wrapped) assert.ok(post.length <= 280, `post is ${post.length} characters`);
  assert.equal(wrapped.join('').replace(/ /g, ''), hard.replace(/ /g, ''), 'a hard wrap keeps every character in order');
  assert.deepEqual(
    await writer.split({ text: 'Anything at all. Even long. '.repeat(100), platform: 'gmail' }),
    ['Anything at all. Even long. '.repeat(100)],
    'a null limit never splits',
  );

  // hello is memoized: later calls reuse the gate and send no new request.
  const seen = fakeEngine();
  const memo = new Compose({ engine: seen });
  assert.deepEqual(await memo.hello(), { protocol: 1, version: '0.0.0-fake' });
  assert.deepEqual(await memo.hello(), { protocol: 1, version: '0.0.0-fake' });
  await memo.platforms();
  await memo.voice.parse('hi');
  assert.deepEqual(seen.requests.map((request) => request.verb), ['hello', 'platforms', 'voice.parse']);
});

test('the kit fails closed on a wrong engine and refuses bad input before the engine', async () => {
  for (const protocol of [2, 0]) {
    const fake = fakeEngine({ protocol });
    const writer = new Compose({ engine: fake });
    const first = await writer.brief({ kind: 'post', platform: 'x' }).then(() => null, (e: unknown) => e);
    assert.ok(first instanceof ComposeError && first.code === 'needs-update');
    assert.deepEqual(first.detail, { protocol });
    const hello = await writer.hello().then(() => null, (e: unknown) => e);
    assert.ok(hello instanceof ComposeError && hello.code === 'needs-update', 'hello itself also rejects');
    assert.deepEqual(fake.requests.map((request) => request.verb), ['hello'], `protocol ${protocol} saw only hello`);
  }

  const failing = fakeEngine({ fail: { verb: 'split', code: 'too-long', message: 'way too long' } });
  const error = await new Compose({ engine: failing }).split({ text: 'hi', platform: 'x' }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ComposeError && error.code === 'engine');
  assert.equal(error.message, 'way too long');
  assert.deepEqual(error.detail, { engineCode: 'too-long' });

  // An engine error for one verb leaves the others answering, and the engine's own platform list is the gate.
  const partlyBroken = fakeEngine({ fail: { verb: 'check', code: 'busy', message: 'too much' } });
  const mixed = new Compose({ engine: partlyBroken });
  const checkError = await mixed.check({ drafts: ['hi'], platform: 'x' }).then(() => null, (e: unknown) => e);
  assert.ok(checkError instanceof ComposeError && checkError.code === 'engine');
  assert.deepEqual(checkError.detail, { engineCode: 'busy' });
  assert.equal((await mixed.platforms()).length, 6, 'other verbs still answer');
  const unknown = await new Compose({ engine: fakeEngine() }).split({ text: 'hi', platform: 'nope' }).then(() => null, (e: unknown) => e);
  assert.ok(unknown instanceof ComposeError && unknown.code === 'engine');
  assert.deepEqual(unknown.detail, { engineCode: 'unknown-platform' });

  // A result outside the frozen shapes is an engine failure, never a crash.
  const shape: Engine = { handle: async () => ({ lines: 'not an array' }) };
  const shapeError = await new Compose({ engine: shape }).brief({ kind: 'reply', platform: 'x' }).then(() => null, (e: unknown) => e);
  assert.ok(shapeError instanceof ComposeError && shapeError.code === 'engine');
  assert.equal(shapeError.message, 'engine answered an unexpected shape');
  const wrongCount: Engine = { handle: async () => [] };
  const countError = await new Compose({ engine: wrongCount }).check({ drafts: ['a'], platform: 'x' }).then(() => null, (e: unknown) => e);
  assert.ok(countError instanceof ComposeError && countError.code === 'engine', 'a check with the wrong draft count is engine');

  // Invalid input is refused before any engine request, hello included.
  const untouched = fakeEngine();
  const strict = new Compose({ engine: untouched });
  const invalid: Array<() => Promise<unknown>> = [
    () => strict.voice.parse(42 as never),
    () => strict.voice.parse('bad\0markdown'),
    () => strict.voice.parse('x'.repeat(100_001)),
    () => strict.voice.guide({ never: 'delve', noDashes: true, statementEndings: false, note: '' } as never),
    () => strict.voice.guide({ never: [], noDashes: 1 as never, statementEndings: false, note: '' }),
    () => strict.voice.guide({ never: [], noDashes: false, statementEndings: false, note: 'n'.repeat(201) }),
    () => strict.brief({ kind: 'email' as never, platform: 'x' }),
    () => strict.brief({ kind: 'reply', platform: '' }),
    () => strict.check({ drafts: [], platform: 'x' }),
    () => strict.check({ drafts: Array(51).fill('hi'), platform: 'x' }),
    () => strict.check({ drafts: ['ok', 7 as never], platform: 'x' }),
    () => strict.check({ drafts: ['hi'], platform: 'x', original: 'n'.repeat(100_001) }),
    () => strict.split({ text: 'hi', platform: 7 as never }),
  ];
  for (const call of invalid) {
    const rejected = await call().then(() => null, (e: unknown) => e);
    assert.ok(rejected instanceof ComposeError && rejected.code === 'invalid', `got ${String(rejected)}`);
  }
  assert.deepEqual(untouched.requests, [], 'validation runs before any engine request, hello included');
});

const TABLE = [
  ['compose.missing', "The writing checker isn't installed yet."],
  ['compose.needsUpdate', 'This app needs an update to check drafts.'],
  ['compose.failed', 'The writing checker stopped with a problem. Try again.'],
  ['check.fits', 'Fits on {platform}.'],
  ['check.tooLong', 'Too long for {platform}: {length} characters, and the most is {limit}.'],
  ['check.voice', 'Goes against your voice: {list}.'],
  ['check.stock', 'Sounds stock: {list}.'],
  ['check.added', "Adds numbers or times the original doesn't have: {list}."],
  ['check.dropped', 'Drops numbers or times from the original: {list}.'],
  ['check.layout', 'The lists or paragraphs changed from the original.'],
  ['check.keptFacts', 'Kept the facts: every number and time from the original is still there.'],
  ['check.pass', 'Ready for you to look over.'],
  ['check.fail', 'Needs another pass.'],
  ['split.posts', 'Split into {count} posts.'],
] as const satisfies readonly (readonly [WordKey, string])[];
// The table is only frozen if it names every key `WordKey` declares: a missing one fails `npm run check`.
type MissingWord = Exclude<WordKey, (typeof TABLE)[number][0]>;
const exhaustive: [MissingWord] extends [never] ? true : never = true;
void exhaustive;

test('the sentences a person reads are frozen, plain and promise nothing about where a draft goes', () => {
  // `words(key)` with no variables keeps every `{slot}` visible, so it round-trips the frozen 4.8 table.
  for (const [key, sentence] of TABLE) assert.equal(words(key), sentence, key);

  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [key] of TABLE) assert.doesNotMatch(words(key).replace(/\{\w+\}/g, 'X'), banned, key);
  assert.equal(
    words('check.tooLong', { platform: 'X', length: '301', limit: '280' }),
    'Too long for X: 301 characters, and the most is 280.',
  );
  assert.equal(words('check.fits', {}), 'Fits on {platform}.', 'unfilled slots stay visible');
  for (const [key] of TABLE) assert.doesNotMatch(words(key), /this phone|\bleaves?\b|never sent/i, key);

  const X: Platform = { id: 'x', label: 'X', kind: 'feed', limit: 280 };
  const passing: DraftCheck = {
    fits: true, length: 212, limit: 280, voice: [], stock: [], added: [], dropped: [], layoutKept: true, words: 'Sounds natural',
  };
  assert.deepEqual(checkLines(passing, X, { original: true }), [
    'Fits on X.',
    'Kept the facts: every number and time from the original is still there.',
    'Ready for you to look over.',
  ]);
  const failing: DraftCheck = {
    fits: false, length: 301, limit: 280, voice: [], stock: [], added: [], dropped: [], layoutKept: true, words: 'A bit stock',
  };
  assert.deepEqual(checkLines(failing, X), [
    'Too long for X: 301 characters, and the most is 280.',
    'Needs another pass.',
  ]);
  const broken: DraftCheck = {
    fits: true, length: 100, limit: 280,
    voice: ['says “delve” from your never-say list'], stock: ['delve'],
    added: ['50'], dropped: ['40'], layoutKept: false, words: 'A bit stock',
  };
  assert.deepEqual(checkLines(broken, X, { original: true }), [
    'Fits on X.',
    'Goes against your voice: says “delve” from your never-say list.',
    'Sounds stock: delve.',
    "Adds numbers or times the original doesn't have: 50.",
    'Drops numbers or times from the original: 40.',
    'The lists or paragraphs changed from the original.',
    'Needs another pass.',
  ]);
  const gmail: Platform = { id: 'gmail', label: 'Gmail', kind: 'mail', limit: null };
  const noLimit: DraftCheck = {
    fits: true, length: 5000, limit: null, voice: [], stock: ['seamless'],
    added: ['1'], dropped: ['2'], layoutKept: false, words: 'A bit stock',
  };
  assert.deepEqual(
    checkLines(noLimit, gmail),
    ['Fits on Gmail.', 'Sounds stock: seamless.', 'Ready for you to look over.'],
    'stock never fails a draft and facts are only checked with an original',
  );
});
