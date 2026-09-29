// The contract suite (docs/capability-kits.md 4.7, 3.4): the same cases run against the fake engine in `npm test`
// (BK-P1) and the real pinned engine in the compose-engine CI job (BK-P2). Cases needing `fake` skip without it.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { Compose } from '../compose.ts';
import { PROTOCOL, PROTOCOL_FLOOR } from '../constants.ts';
import { ComposeError } from '../errors.ts';
import type { BriefKind } from '../types.ts';
import { fakeEngine } from './fake-engine.ts';
import type { FakeEngine } from './fake-engine.ts';

export type ComposeContractBench = { compose: Compose; fake?: FakeEngine };
export type ComposeContractTestFn = (
  name: string,
  fn: (t: { skip(message?: string): void }) => void | Promise<void>,
) => void | Promise<void>;
export type ComposeContractOptions = {
  /** The runner's `test` (node:test's by default). */
  test?: ComposeContractTestFn;
};

const PLATFORM_TABLE = [
  { id: 'x', kind: 'feed', limit: 280 },
  { id: 'linkedin', kind: 'feed', limit: 3000 },
  { id: 'reddit', kind: 'feed', limit: 10000 },
  { id: 'slack', kind: 'chat', limit: 40000 },
  { id: 'whatsapp', kind: 'chat', limit: 65536 },
  { id: 'gmail', kind: 'mail', limit: null },
] as const;

export function composeContract(
  make: () => Promise<ComposeContractBench>,
  options?: ComposeContractOptions | ComposeContractTestFn,
): void {
  const runTest: ComposeContractTestFn =
    typeof options === 'function' ? options : (options?.test ?? (nodeTest as unknown as ComposeContractTestFn));

  async function fakeBench(t: { skip(message?: string): void }): Promise<ComposeContractBench> {
    const bench = await make();
    if (bench.fake === undefined) t.skip('needs the fake engine');
    return bench;
  }

  runTest('hello: protocol in range and a non-empty version', async () => {
    const { compose } = await make();
    const hello = await compose.hello();
    assert.ok(hello.protocol >= PROTOCOL_FLOOR && hello.protocol <= PROTOCOL, `protocol ${hello.protocol}`);
    assert.equal(typeof hello.version, 'string');
    assert.ok(hello.version.length > 0);
  });

  runTest('platforms: the six of 10.1 with exactly those limits and kinds', async () => {
    const { compose } = await make();
    const platforms = await compose.platforms();
    for (const expected of PLATFORM_TABLE) {
      const found = platforms.find((platform) => platform.id === expected.id);
      assert.ok(found !== undefined, `platform ${expected.id}`);
      assert.equal(found.limit, expected.limit);
      assert.equal(found.kind, expected.kind);
    }
  });

  runTest('check on x with a 300-character draft: too long at 280', async () => {
    const { compose } = await make();
    const [result] = await compose.check({ drafts: ['a'.repeat(300)], platform: 'x' });
    assert.ok(result !== undefined);
    assert.equal(result.fits, false);
    assert.equal(result.length, 300);
    assert.equal(result.limit, 280);
  });

  runTest('check with a never-say rule names the break in plain words', async () => {
    const { compose } = await make();
    const [result] = await compose.check({
      drafts: ["Let's delve in."],
      platform: 'x',
      rules: { never: ['delve'], noDashes: false, statementEndings: false, note: '' },
    });
    assert.ok(result !== undefined);
    assert.equal(result.voice.length, 1);
    assert.match(result.voice[0] ?? '', /delve/);
  });

  runTest('check tracks the numbers against the original, and none without one', async () => {
    const { compose } = await make();
    const original = 'Meet at 3pm on Friday, 40 seats.';
    const draft = 'Meet at 3pm on Friday, 50 seats.';
    const [withOriginal] = await compose.check({ drafts: [draft], platform: 'x', original });
    assert.ok(withOriginal !== undefined);
    assert.ok(withOriginal.added.includes('50'), `added: ${withOriginal.added}`);
    assert.ok(withOriginal.dropped.includes('40'), `dropped: ${withOriginal.dropped}`);
    const [withoutOriginal] = await compose.check({ drafts: [draft], platform: 'x' });
    assert.ok(withoutOriginal !== undefined);
    assert.deepEqual(withoutOriginal.added, []);
    assert.deepEqual(withoutOriginal.dropped, []);
  });

  runTest('split on x keeps every post under the limit and the words in order', async () => {
    const { compose } = await make();
    const text = Array(30).fill('All systems go now.').join(' ');
    assert.ok(text.length > 280, `text is ${text.length} characters`);
    const posts = await compose.split({ text, platform: 'x' });
    assert.ok(posts.length > 1, 'a long text splits');
    for (const post of posts) assert.ok(post.length <= 280, `post is ${post.length} characters`);
    assert.equal(posts.join(' '), text.replace(/\s+/g, ' ').trim());
  });

  runTest('voice.parse reads the never-say bullets, quoted or not', async () => {
    const { compose } = await make();
    const parsed = await compose.voice.parse('## Never say\n- delve\n- "game changer"\n');
    assert.ok(parsed.rules.never.includes('delve'), `never: ${parsed.rules.never}`);
    assert.ok(parsed.rules.never.includes('game changer'), `never: ${parsed.rules.never}`);
  });

  runTest('voice.guide names the dash rule', async () => {
    const { compose } = await make();
    const line = await compose.voice.guide(
      { never: [], noDashes: true, statementEndings: false, note: '' }, { post: false },
    );
    assert.match(line, /dash/i);
  });

  runTest('brief of each kind on x gives at least one non-empty line', async () => {
    const { compose } = await make();
    const kinds: BriefKind[] = ['reply', 'polish', 'post', 'thread'];
    for (const kind of kinds) {
      const lines = await compose.brief({ kind, platform: 'x' });
      assert.ok(lines.length >= 1, `brief ${kind} has lines`);
      for (const line of lines) assert.ok(line.length > 0, `brief ${kind} line is non-empty`);
    }
  });

  runTest('fake: an out-of-range protocol fails closed after hello alone', async (t) => {
    await fakeBench(t);
    for (const protocol of [PROTOCOL + 1, 0]) {
      const fake = fakeEngine({ protocol });
      const compose = new Compose({ engine: fake });
      const first = await compose.platforms().then(() => null, (e: unknown) => e);
      assert.ok(first instanceof ComposeError && first.code === 'needs-update', `protocol ${protocol} first call`);
      assert.deepEqual(first.detail, { protocol });
      const second = await compose.platforms().then(() => null, (e: unknown) => e);
      assert.ok(second instanceof ComposeError && second.code === 'needs-update', `protocol ${protocol} second call`);
      assert.deepEqual(fake.requests.map((request) => request.verb), ['hello'], `protocol ${protocol} saw only hello`);
    }
  });

  runTest('fake: an engine failure rejects with its code', async (t) => {
    await fakeBench(t);
    const fake = fakeEngine({ fail: { verb: 'check', code: 'overloaded', message: 'too much at once' } });
    const compose = new Compose({ engine: fake });
    const error = await compose.check({ drafts: ['hi'], platform: 'x' }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ComposeError && error.code === 'engine');
    assert.equal(error.message, 'too much at once');
    assert.deepEqual(error.detail, { engineCode: 'overloaded' });
  });

  runTest('invalid input rejects before the engine', async (t) => {
    const bench = await make();
    const invalid: Array<() => Promise<unknown>> = [
      () => bench.compose.check({ drafts: [], platform: 'x' }),
      () => bench.compose.check({ drafts: ['bad\0draft'], platform: 'x' }),
      () => bench.compose.check({
        drafts: ['hi'], platform: 'x', rules: { never: [], noDashes: false, statementEndings: false, note: 'n'.repeat(201) },
      }),
    ];
    for (const call of invalid) {
      const error = await call().then(() => null, (e: unknown) => e);
      assert.ok(error instanceof ComposeError && error.code === 'invalid', `got ${String(error)}`);
    }
    if (bench.fake !== undefined) assert.deepEqual(bench.fake.requests, [], 'no engine request was sent');
  });
}
