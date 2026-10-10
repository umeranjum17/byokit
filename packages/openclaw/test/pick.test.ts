// The kit's pure picker (docs/runtime-kits.md 5.13, 5.15) runs EVERY row of the shared parity table through the
// published `@byokit/openclaw` entry (its dist, the way a consumer app sees it), including the kit-only bound rows
// that `@byokit/accounts` skips. An explicit signed-out id is returned as chosen and never replaced; a default
// outside `bound` is marked `out: 'bound'`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSelection, type Account, type Defaults, type ModelInfo, type Room, type RunSelection } from '@byokit/openclaw';

type AccountRecord = { id: string; provider: string; name: string; state: Account['state']; billing: Account['billing']; until?: number };
type Case = {
  name: string; accounts: AccountRecord[]; rooms: Record<string, Room>; defaults: Defaults; selection: RunSelection;
  bound?: string[]; models?: Record<string, { id: string; available: boolean }[]>;
  expected: { ok: boolean; id?: string; why?: string; how?: string; model?: string; code?: string };
  considered?: Record<string, Record<string, unknown>>; reason?: string; reasonContains?: string; kitOnly?: boolean;
};
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/auto-pick-typescript.json', import.meta.url), 'utf8')) as { now: number; cases: Case[] };
for (const c of fixture.cases) test(`OpenClaw pick conformance: ${c.name}`, () => {
  const accounts: Account[] = c.accounts.map((a) => ({ ...a, route: `${a.provider}:test`, label: a.provider, addedAt: 0 }));
  const calls: { id: string; demand: readonly string[] }[] = [];
  const rooms = (a: Account, demand: readonly string[]) => { calls.push({ id: a.id, demand }); return c.rooms[a.id] ?? { left: 'unknown' }; };
  const models = (a: Account): readonly ModelInfo[] => (c.models?.[a.id] ?? [{ id: `${a.provider}/m`, available: true }]).map((m) => ({ ...m, name: m.id }));
  const picked = resolveSelection(accounts, c.defaults, c.selection, rooms, fixture.now, models, c.bound);
  const actual = picked.ok ? { ok: true, id: picked.account.id, why: picked.why, how: picked.how, model: picked.model } : { ok: false, code: picked.code };
  assert.deepEqual(actual, c.expected);
  assert.deepEqual(picked.considered.map((r) => r.id), accounts.map((a) => a.id), 'one row per account in list order');
  assert.deepEqual(calls.map((r) => r.id), accounts.map((a) => a.id), 'one room measurement per account, shared by ranking and explanations');
  const demand = [...new Set([...(c.selection.model ? [c.selection.model] : []), ...(c.selection.needs ?? [])])];
  assert.ok(calls.every((r) => JSON.stringify(r.demand) === JSON.stringify(demand)), 'deduplicated demand passed to room');
  for (const [id, expected] of Object.entries(c.considered ?? {})) {
    const row = picked.considered.find((r) => r.id === id)!;
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(row[key as keyof typeof row] ?? null, value, `${id}.${key}`);
  }
  if (c.reason) assert.equal(picked.reason, c.reason);
  if (c.reasonContains) assert.ok(picked.reason.includes(c.reasonContains));
  if (picked.ok) assert.equal(picked.considered.find((r) => r.id === picked.account.id)!.reason, picked.why);
});
