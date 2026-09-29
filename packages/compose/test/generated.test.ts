// BK-P2 (docs/capability-kits.md 9.2, D-I): the committed engine schema is the pinned one, the generated wire types
// are fresh, and they match the frozen public types of 4.3. The type assertions are checked by `npm run check`.
//
// The engine's schema is looser than the kit on params: every `rules` field and both `voice.guide` params are
// optional there, and `drafts` is a non-empty tuple. The kit always sends the complete shape, so params are proven
// by key-set equality both ways plus the kit's params fitting the wire; `Rules`, kinds and result keys are equal.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../scripts/gen-types.ts';
import { ENGINE_SCHEMA_SHA256 } from '../src/constants.ts';
import type { WireParams, WirePlatformId, WirePlatformKind, WireResults, WireRules, WireVerb } from '../src/generated/protocol.ts';
import type { BriefKind, EngineVerb, EngineVerbs, PlatformKind, Rules } from '../src/types.ts';

const schemaBytes = readFileSync(new URL('../schema/engine-protocol-1.json', import.meta.url));
const generated = readFileSync(new URL('../src/generated/protocol.ts', import.meta.url), 'utf8');

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

/** The kit's params as its validation leaves them: a known platform id, at least one draft. */
type Sent<P> = {
  [K in keyof P]: K extends 'platform' ? WirePlatformId : K extends 'drafts' ? [string, ...string[]] : P[K];
};
type Item<R> = R extends readonly (infer I)[] ? I : R;
type Result<V extends WireVerb> = EngineVerbs[V]['result'];

/** Named keys only: the kit's empty params are `Record<string, never>`, whose keyof is `string`. */
type Keys<P> = string extends keyof P ? never : keyof P;
type Both<A, B> = [A, B] extends [true, true] ? true : false;

type ParamsMatch<V extends WireVerb> = Both<
  Equals<Keys<WireParams[V]>, Keys<EngineVerbs[V]['params']>>,
  Sent<EngineVerbs[V]['params']> extends WireParams[V] ? true : false
>;
type ResultMatches<V extends WireVerb> = Both<
  Equals<WireResults[V]['keys'], keyof Item<Result<V>>>,
  Equals<WireResults[V]['list'], Result<V> extends readonly unknown[] ? true : false>
>;

export type Proofs = [
  Assert<Equals<WireVerb, Exclude<EngineVerb, 'hello'>>>,
  Assert<Equals<Required<WireRules>, Rules>>,
  Assert<Equals<WirePlatformKind, PlatformKind>>,
  Assert<Equals<WireParams['brief']['kind'], BriefKind>>,
  Assert<ParamsMatch<'voice.parse'>>, Assert<ParamsMatch<'voice.guide'>>, Assert<ParamsMatch<'platforms'>>, Assert<ParamsMatch<'brief'>>,
  Assert<ParamsMatch<'check'>>, Assert<ParamsMatch<'split'>>,
  Assert<ResultMatches<'voice.parse'>>, Assert<ResultMatches<'voice.guide'>>, Assert<ResultMatches<'platforms'>>, Assert<ResultMatches<'brief'>>,
  Assert<ResultMatches<'check'>>, Assert<ResultMatches<'split'>>,
];

test('the committed schema is the pinned one (ENGINE_SCHEMA_SHA256)', () => {
  assert.equal(createHash('sha256').update(schemaBytes).digest('hex'), ENGINE_SCHEMA_SHA256);
});

test('regeneration from the committed schema is byte-identical', async () => {
  assert.equal(await generate(JSON.parse(schemaBytes.toString('utf8'))), generated);
});

test('the schema names the six platforms of 10.1 and the three error codes', () => {
  const schema = JSON.parse(schemaBytes.toString('utf8'));
  assert.deepEqual(schema.$defs.platformId.enum, ['x', 'linkedin', 'reddit', 'slack', 'whatsapp', 'gmail']);
  assert.deepEqual(schema.$defs.error.properties.error.properties.code.enum, ['bad-request', 'unknown-verb', 'internal']);
});
