// BK-0 acceptance: every frozen name exists — the `.` entry (4.3–4.5), `./testing` (4.7) and the CLI seam (4.6) —
// and every stub names the work package that fills it (docs/capability-kits.md §9.2).
import { test, todo } from 'node:test';
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
  const engine: Engine = { handle: async () => ({}) };
  const c = new kit.Compose({ engine });
  assert.throws(() => c.hello(), /BK-P1/);
  assert.throws(() => c.voice.parse('# Voice'), /BK-P1/);
  assert.throws(() => c.voice.guide(rules, { post: true }), /BK-P1/);
  assert.throws(() => c.platforms(), /BK-P1/);
  assert.throws(() => c.brief({ kind: 'reply', platform: 'x', rules }), /BK-P1/);
  assert.throws(() => c.check({ drafts: ['a'], platform: 'x', rules, original: 'b' }), /BK-P1/);
  assert.throws(() => c.split({ text: 'a', platform: 'x' }), /BK-P1/);
  assert.throws(() => kit.inProcessEngine(), /BK-P2/);
  assert.throws(() => kit.binEngine({ bin: '/usr/bin/engine' }), /BK-P2/);
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

test('./testing and the CLI seam are in place; bodies land in BK-P1', async () => {
  assert.equal(typeof testing.fakeEngine, 'function');
  assert.equal(typeof testing.composeContract, 'function');
  assert.throws(() => testing.fakeEngine({ protocol: 2 }), /BK-P1/);
  assert.throws(() => testing.composeContract(async () => ({ compose: new kit.Compose() })), /BK-P1/);
  const out: string[] = [];
  const code = await main(['platforms'], { stdout: (s) => out.push(s), stderr: (s) => out.push(s), readFile: () => '' });
  assert.equal(code, 4);
  assert.deepEqual(out, ['error: not built: BK-P1\n']);
  assert.throws(() => kit.checkLines({} as DraftCheck, {} as Platform), /BK-P1/);
});

// BK-P2 pins the published engine: ENGINE_VERSION, the dependency and the schema's sha256.
todo('ENGINE_SCHEMA_SHA256 pins the committed engine schema, not the placeholder', () => {
  assert.match(ENGINE_SCHEMA_SHA256, /^[0-9a-f]{64}$/);
});
