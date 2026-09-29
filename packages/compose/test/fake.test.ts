// BK-P1 (docs/capability-kits.md 4.7): the fake engine's own small logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compose } from '../src/compose.ts';
import { ComposeError } from '../src/errors.ts';
import { fakeEngine } from '../src/testing/fake-engine.ts';

test('hello answers the configured protocol and version', async () => {
  const fake = fakeEngine();
  assert.deepEqual(await fake.handle({ verb: 'hello', params: {} }), { protocol: 1, version: '0.0.0-fake' });
  const pinned = fakeEngine({ protocol: 9, version: '1.0.0' });
  assert.deepEqual(await pinned.handle({ verb: 'hello', params: {} }), { protocol: 9, version: '1.0.0' });
});

test('platforms returns the six of 10.1 with slots and polish', async () => {
  const fake = fakeEngine();
  const platforms = await new Compose({ engine: fake }).platforms();
  assert.deepEqual(platforms.map((platform) => [platform.id, platform.limit, platform.kind]), [
    ['x', 280, 'feed'], ['linkedin', 3000, 'feed'], ['reddit', 10000, 'feed'],
    ['slack', 40000, 'chat'], ['whatsapp', 65536, 'chat'], ['gmail', null, 'mail'],
  ]);
  for (const platform of platforms) {
    assert.deepEqual(platform.slots, [
      'Agree and add one concrete detail.',
      'Push back kindly, with one reason.',
      'Ask one sharp question.',
    ]);
  }
  assert.equal(platforms.find((platform) => platform.id === 'x')?.polish, 'The first line must stand alone.');
  assert.equal(platforms.find((platform) => platform.id === 'gmail')?.polish, '');
});

test('voice.parse collects the never-say bullets, quoted or not', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  const parsed = await compose.voice.parse('## Never say\n- delve\n- "game changer"\n');
  assert.deepEqual(parsed.rules.never, ['delve', 'game changer']);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.rules.noDashes, false);
  const dashes = await compose.voice.parse('# Voice\nWe avoid the em dash here.\n## Never say\n- seamless\n');
  assert.equal(dashes.rules.noDashes, true);
  assert.deepEqual(dashes.rules.never, ['seamless']);
  const outside = await compose.voice.parse('- delve\n# Later\nSome text.\n');
  assert.deepEqual(outside.rules.never, [], 'bullets outside a never-say heading do not count');
  const long = await compose.voice.parse(`## Never say\n- ${'w'.repeat(201)}\n- ok\n`);
  assert.deepEqual(long.rules.never, ['ok']);
  assert.equal(long.skipped, 1);
});

test('voice.guide joins the rules that apply', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  assert.equal(
    await compose.voice.guide({ never: [], noDashes: true, statementEndings: false, note: '' }),
    'No em dashes.',
  );
  assert.equal(
    await compose.voice.guide({ never: [], noDashes: true, statementEndings: true, note: 'Short lines.' }, { post: true }),
    'No em dashes. End on a statement, not a question. How they write: Short lines.',
  );
  assert.equal(
    await compose.voice.guide({ never: [], noDashes: false, statementEndings: true, note: '' }),
    '',
    'the statement rule is for posts only',
  );
});

test('brief answers each kind from the platform', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  assert.deepEqual(await compose.brief({ kind: 'reply', platform: 'x' }), [
    'Agree and add one concrete detail.',
    'Push back kindly, with one reason.',
    'Ask one sharp question.',
  ]);
  assert.deepEqual(await compose.brief({ kind: 'polish', platform: 'x' }), ['The first line must stand alone.']);
  assert.deepEqual(await compose.brief({ kind: 'polish', platform: 'gmail' }), [], 'no polish rule means no lines');
  assert.deepEqual(await compose.brief({ kind: 'post', platform: 'linkedin' }), ['One post for LinkedIn.']);
  assert.deepEqual(await compose.brief({ kind: 'thread', platform: 'reddit' }), ['One post for Reddit.']);
});

test('check measures in UTF-16 units and names every break', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  const [checked] = await compose.check({
    drafts: ['Lets delve in at 3pm, 50 seats.'],
    platform: 'x',
    rules: { never: ['delve'], noDashes: false, statementEndings: false, note: '' },
    original: 'Lets meet at 3pm, 40 seats.',
  });
  assert.ok(checked !== undefined);
  assert.equal(checked.length, 'Lets delve in at 3pm, 50 seats.'.length);
  assert.equal(checked.limit, 280);
  assert.equal(checked.fits, true);
  assert.deepEqual(checked.voice, ['says “delve” from your never-say list']);
  assert.deepEqual(checked.stock, ['delve']);
  assert.deepEqual(checked.added, ['50']);
  assert.deepEqual(checked.dropped, ['40']);
  assert.equal(checked.layoutKept, true);
  assert.equal(checked.words, 'A bit stock');
  const [clean] = await compose.check({ drafts: ['Hello there.'], platform: 'gmail' });
  assert.ok(clean !== undefined);
  assert.equal(clean.fits, true, 'a null limit always fits');
  assert.equal(clean.words, 'Sounds natural');
  const [lists] = await compose.check({
    drafts: ['- one\n- two\n'], platform: 'x', original: 'Just words.\n',
  });
  assert.ok(lists !== undefined);
  assert.equal(lists.layoutKept, false, 'a changed list count breaks the layout');
});

test('split packs sentences under the limit and hard-wraps a long one', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  const posts = await compose.split({ text: Array(30).fill('All systems go now.').join(' '), platform: 'x' });
  assert.ok(posts.length > 1);
  for (const post of posts) assert.ok(post.length <= 280);
  const long = `First. ${'w'.repeat(300)}. Last.`;
  const wrapped = await compose.split({ text: long, platform: 'x' });
  for (const post of wrapped) assert.ok(post.length <= 280, `post is ${post.length} characters`);
  assert.equal(wrapped.join('').replace(/ /g, ''), long.replace(/ /g, ''), 'a hard wrap keeps every character in order');
  assert.deepEqual(await compose.split({ text: 'Anything at all. Even long. '.repeat(100), platform: 'gmail' }), [
    'Anything at all. Even long. '.repeat(100),
  ], 'a null limit never splits');
});

test('fail answers the error envelope for that verb only', async () => {
  const fake = fakeEngine({ fail: { verb: 'check', code: 'busy', message: 'too much' } });
  const compose = new Compose({ engine: fake });
  const error = await compose.check({ drafts: ['hi'], platform: 'x' }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ComposeError && error.code === 'engine');
  assert.deepEqual(error.detail, { engineCode: 'busy' });
  assert.deepEqual((await compose.platforms()).length, 6, 'other verbs still answer');
});

test('an unknown platform answers the unknown-platform envelope', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  const error = await compose.split({ text: 'hi', platform: 'nope' }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ComposeError && error.code === 'engine');
  assert.deepEqual(error.detail, { engineCode: 'unknown-platform' });
});

test('requests logs every request in order', async () => {
  const fake = fakeEngine();
  const compose = new Compose({ engine: fake });
  await compose.platforms();
  await compose.voice.parse('hi');
  assert.deepEqual(fake.requests, [
    { verb: 'hello', params: {} },
    { verb: 'platforms', params: {} },
    { verb: 'voice.parse', params: { markdown: 'hi' } },
  ], 'hello runs once per Compose; later methods reuse the memoized gate');
});
