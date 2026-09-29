// BK-P2 (docs/capability-kits.md 4.5, 9.2): the engine seams. The client and the contract run over a stub that speaks
// the engine's wire and checks every request against the committed schema, in process and as a bin; `binEngine`'s
// supervision runs against small fake JS bins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from '../../test-support.ts';
import { Compose } from '../src/compose.ts';
import { binEngine, inProcessEngine, moduleEngine } from '../src/engine.ts';
import { ComposeError } from '../src/errors.ts';
import { composeContract } from '../src/testing/index.ts';
import { engineStub, wireBreaks } from './fixtures/engine-stub.ts';

const stubBin = fileURLToPath(new URL('./fixtures/engine-stub-bin.ts', import.meta.url));

function fakeBin(source: string): string {
  const bin = join(scratchDir('compose-bin'), 'engine.mjs');
  writeFileSync(bin, source);
  return bin;
}

async function rejectsCode(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ComposeError, String(e));
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });
}

// --- the contract over the stub's wire, in process --------------------------------------------------------------
const stub = engineStub();
composeContract(async () => ({ compose: new Compose({ engine: moduleEngine(async () => stub) }) }), {
  test: (name, fn) => test(`in process over the schema stub: ${name}`, fn),
});

test('in process: every request the contract sent conforms to the committed schema', () => {
  assert.ok(stub.wire.length >= 10, `${stub.wire.length} wire requests`);
  assert.deepEqual(stub.violations, []);
  assert.ok(stub.wire.every((r) => (r as { verb: string }).verb !== 'hello'), 'hello stays off the schema wire');
});

// --- the same contract through binEngine and the stub bin --------------------------------------------------------
composeContract(async () => ({ compose: new Compose({ engine: binEngine({ bin: stubBin }) }) }), {
  test: (name, fn) => test(`as a bin over the schema stub: ${name}`, fn),
});

test('the schema check itself refuses the old nested envelope and unknown fields', () => {
  assert.match(wireBreaks({ verb: 'split', params: { text: 'a', platform: 'x' } })!, /params is not allowed|required/);
  assert.match(wireBreaks({ verb: 'check', drafts: [], platform: 'x' })!, /1\+ items/);
  assert.match(wireBreaks({ verb: 'brief', kind: 'reply', platform: 'mastodon' })!, /one of/);
  assert.equal(wireBreaks({ verb: 'check', drafts: ['a'], platform: 'x', rules: { never: [], noDashes: true, statementEndings: false, note: '' } }), null);
});

// --- moduleEngine / inProcessEngine ------------------------------------------------------------------------------
test('inProcessEngine: without the package installed the client rejects missing', async (t) => {
  try {
    import.meta.resolve('ownvoice-engine');
    t.skip('ownvoice-engine is installed here; test/engine/ covers it');
    return;
  } catch { /* not installed: the case under test */ }
  await rejectsCode(new Compose({ engine: inProcessEngine() }).hello(), 'missing');
  await rejectsCode(new Compose().platforms(), 'missing');
});

test('moduleEngine: a load failure is engine, a throw is the internal envelope, a failed load is retried', async () => {
  const notFound = Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' });
  await rejectsCode(moduleEngine(async () => { throw notFound; }).handle({ verb: 'platforms', params: {} }), 'missing');
  await rejectsCode(moduleEngine(async () => { throw new SyntaxError('bad'); }).handle({ verb: 'platforms', params: {} }), 'engine', /failed to load/);
  await rejectsCode(moduleEngine(async () => ({})).handle({ verb: 'platforms', params: {} }), 'engine', /no protocol handle/);

  let loads = 0;
  const flaky = moduleEngine(async () => {
    loads += 1;
    if (loads === 1) throw notFound;
    return { handle: () => { throw new Error('boom'); }, hello: () => ({ protocol: 1, version: '0.1.0' }) };
  });
  await rejectsCode(flaky.handle({ verb: 'hello', params: {} }), 'missing');
  assert.deepEqual(await flaky.handle({ verb: 'hello', params: {} }), { protocol: 1, version: '0.1.0' });
  assert.deepEqual(await flaky.handle({ verb: 'platforms', params: {} }), { error: { code: 'internal', message: 'boom' } });
  assert.equal(loads, 2);
});

test('the version gate: a stub below the floor or above the protocol is needs-update, and no verb reaches it', async () => {
  for (const protocol of [0, 2]) {
    const low = engineStub({ protocol });
    const compose = new Compose({ engine: moduleEngine(async () => low) });
    await rejectsCode(compose.hello(), 'needs-update');
    await rejectsCode(compose.platforms(), 'needs-update');
    assert.deepEqual(low.wire, []);
  }
});

// --- binEngine supervision ---------------------------------------------------------------------------------------
const ECHO = `let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), env: process.env, input }));
`;

test('binEngine: runs the bin under this Node with argv [bin] and env exactly { PATH, LANG }', async () => {
  const bin = fakeBin(ECHO);
  const engine = binEngine({ bin });
  const answer = await engine.handle({ verb: 'split', params: { text: 'a b', platform: 'x' } }) as { argv: string[]; env: object; input: string };
  assert.deepEqual(answer.argv, [bin]);
  assert.deepEqual(answer.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
  assert.equal(answer.input, '{"verb":"split","text":"a b","platform":"x"}\n');
  // hello is the engine bin's own argument, with nothing on stdin.
  const hello = await engine.handle({ verb: 'hello', params: {} }) as { argv: string[]; input: string };
  assert.deepEqual([hello.argv, hello.input], [[bin, 'hello'], '']);
});

test('binEngine: a missing or relative bin is missing', async () => {
  const request = { verb: 'platforms', params: {} } as const;
  await rejectsCode(binEngine({ bin: '/nonexistent/ownvoice-engine' }).handle(request), 'missing');
  await rejectsCode(binEngine({ bin: 'bin/ownvoice-engine' }).handle(request), 'missing');
  await rejectsCode(new Compose({ engine: binEngine({ bin: '/nonexistent/ownvoice-engine' }) }).hello(), 'missing');
});

test('binEngine: an error answer on exit 1 passes through; exit non-zero with no JSON is engine', async () => {
  const envelope = fakeBin(`process.stdout.write('{"error":{"code":"bad-request","message":"nope"}}\\n'); process.exitCode = 1;`);
  assert.deepEqual(await binEngine({ bin: envelope }).handle({ verb: 'platforms', params: {} }), { error: { code: 'bad-request', message: 'nope' } });
  const crash = fakeBin(`process.stderr.write('boom'); process.exit(3);`);
  await rejectsCode(binEngine({ bin: crash }).handle({ verb: 'platforms', params: {} }), 'engine', /exited 3 with no JSON/);
});

test('binEngine: the timeout is clamped to at least 1 s and kills the bin', async () => {
  const hang = fakeBin('setInterval(() => {}, 1000);');
  const started = performance.now();
  await rejectsCode(binEngine({ bin: hang, timeoutMs: 10 }).handle({ verb: 'platforms', params: {} }), 'engine', /within 1000 ms/);
  const took = performance.now() - started;
  assert.ok(took >= 900 && took < 5000, `${took} ms`);
});

test('binEngine: more than 8 MB on either stream is engine', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const flood = fakeBin(`const block = 'x'.repeat(1 << 20); for (let i = 0; i < 9; i++) process.${stream}.write(block);`);
    await rejectsCode(binEngine({ bin: flood }).handle({ verb: 'platforms', params: {} }), 'engine', new RegExp(`8 MB on ${stream}`));
  }
});
