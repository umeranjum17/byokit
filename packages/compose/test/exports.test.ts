// BK-P1/BK-P2: every frozen name exists and behaves — the `.` entry (4.3–4.5), `./testing` (4.7), the CLI seam (4.6)
// and the engine pin (4.9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../src/index.ts';
import * as testing from '../src/testing/index.ts';
import { main } from '../src/cli.ts';
import { ENGINE_SCHEMA_SHA256 } from '../src/constants.ts';
import type {
  BriefKind, ComposeErrorCode, DraftCheck, Engine, EngineRequest, EngineVerb, ParsedVoice, Platform, Rules,
} from '../src/index.ts';

const rules: Rules = { never: ['delve'], noDashes: true, statementEndings: false, note: '' };

test('the `.` entry carries the frozen surface (4.3–4.5)', async () => {
  assert.equal(kit.ENGINE_PACKAGE, 'ownvoice-engine');
  assert.equal(kit.PROTOCOL, 1);
  assert.equal(kit.PROTOCOL_FLOOR, 1);
  for (const fn of [kit.Compose, kit.ComposeError, kit.inProcessEngine, kit.binEngine, kit.words, kit.errorWords, kit.checkLines]) {
    assert.equal(typeof fn, 'function');
  }
  const fake = testing.fakeEngine({ version: '1.0.0' });
  const c = new kit.Compose({ engine: fake });
  assert.deepEqual(await c.hello(), { protocol: 1, version: '1.0.0' });
  assert.equal((await c.platforms()).length, 6);
  assert.deepEqual((await c.voice.parse('## Never say\n- delve\n')).rules.never, ['delve']);
  assert.match(await c.voice.guide(rules), /dash/i);
  assert.ok((await c.brief({ kind: 'reply', platform: 'x', rules })).length >= 1);
  assert.equal((await c.check({ drafts: ['hi'], platform: 'x', rules, original: 'yo' })).length, 1);
  assert.ok((await c.split({ text: 'hi. yo.', platform: 'x' })).length >= 1);
  assert.equal(typeof kit.inProcessEngine().handle, 'function');
  await assert.rejects(kit.binEngine({ bin: '/nonexistent/engine' }).handle({ verb: 'hello', params: {} }), { code: 'missing' });
});

test('ComposeError carries its code and detail', () => {
  const e = new kit.ComposeError('engine', 'bad', { engineCode: 'unknown-platform' });
  assert.ok(e instanceof Error);
  assert.deepEqual([e.name, e.code, e.message, e.detail], ['ComposeError', 'engine', 'bad', { engineCode: 'unknown-platform' }]);
  const codes: ComposeErrorCode[] = ['missing', 'needs-update', 'engine', 'invalid'];
  assert.deepEqual(codes.map((c) => kit.errorWords(new kit.ComposeError(c, ''))), [
    "The writing checker isn't installed yet.",
    'This app needs an update to check drafts.',
    'The writing checker stopped with a problem. Try again.',
    'The writing checker stopped with a problem. Try again.',
  ]);
});

test('public types keep their frozen shapes (4.3)', () => {
  const platform: Platform = { id: 'gmail', label: 'Gmail', kind: 'mail', limit: null, slots: ['a', 'b', 'c'], polish: '' };
  const check: DraftCheck = {
    fits: true, length: 12, limit: null, voice: [], stock: [], added: [], dropped: [], layoutKept: true, words: 'Sounds natural',
  };
  const parsed: ParsedVoice = { rules, skipped: 0 };
  const kind: BriefKind = 'thread';
  const verb: EngineVerb = 'voice.guide';
  const requests: EngineRequest[] = [
    { verb: 'hello', params: {} }, { verb: 'voice.parse', params: { markdown: '' } },
    { verb: 'voice.guide', params: { rules, post: false } }, { verb: 'platforms', params: {} },
    { verb: 'brief', params: { kind, platform: 'x' } }, { verb: 'check', params: { drafts: ['a'], platform: 'x', original: 'b' } },
    { verb: 'split', params: { text: 'a', platform: 'x' } },
  ];
  // @ts-expect-error a verb's params are checked against the verb
  const wrong: EngineRequest = { verb: 'split', params: { markdown: '' } };
  void [platform, check, parsed, verb, requests, wrong];
});

test('./testing and the CLI seam behave (4.6–4.7)', async () => {
  const fake = testing.fakeEngine();
  assert.deepEqual(fake.requests, []);
  assert.equal(typeof testing.composeContract, 'function');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const engine: Engine = testing.fakeEngine({ version: '9.9.9' });
  const code = await main(['hello'], {
    engine,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    readFile: () => '',
  });
  assert.equal(code, 0);
  assert.deepEqual(stdout, ['protocol: 1\nversion: 9.9.9\n']);
  assert.deepEqual(stderr, []);
  const platform: Platform = { id: 'x', label: 'X', kind: 'feed', limit: 280 };
  const check: DraftCheck = {
    fits: true, length: 10, limit: 280, voice: [], stock: [], added: [], dropped: [], layoutKept: true, words: 'Sounds natural',
  };
  assert.deepEqual(kit.checkLines(check, platform, { original: true }), [
    'Fits on X.',
    'Kept the facts: every number and time from the original is still there.',
    'Ready for you to look over.',
  ]);
});

// BK-P2 pins the engine: ENGINE_VERSION and the committed schema's sha256 (test/generated.test.ts hashes the file).
test('ENGINE_SCHEMA_SHA256 pins the committed engine schema, not the placeholder', () => {
  assert.match(ENGINE_SCHEMA_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(kit.ENGINE_VERSION, '0.1.0');
});
