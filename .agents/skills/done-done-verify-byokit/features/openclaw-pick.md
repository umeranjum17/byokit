# OpenClaw pure account pick with bound (5.13, 5.15)

The built `@byokit/openclaw` exposes a pure start-of-run picker. `resolveSelection(accounts, defaults, selection, room, nowMs, models?, bound?)` resolves `{ account: 'auto' | 'default' | id, model, needs }` against the restated account types and returns an `AccountPick` with one `considered` row per account, so an app can say which account a run would use before it starts. `bound` is the kit-only list of accounts a conversation may use: an account outside it is never a candidate (its row is `out: 'bound'`), a default outside `bound` is treated as not ready and falls through, and an explicit signed-out id inside `bound` is returned as chosen and never replaced. No credential, provider, engine or spend is involved.

## Sub-features

- `resolveSelection` runs the shared parity table `fixtures/conformance/auto-pick-typescript.json`; the kit-only `bound` rows that `@byokit/accounts`' `multi.test.ts` skips are run here too.
- `consider` and `chooseAccount` are exported alongside it (`RoomOf` too) for callers that need the rows or Auto's winner alone.
- No `@byokit/accounts` import (D3): the shape and the eligibility/ranking rules are restated, `bound` included.

## How to get to it (user POV)

A host app signed a member in and, at run start, resolves which account a conversation uses. It calls the picker with that conversation's `bound` accounts and shows the kit's sentence for the outcome. This slice is the pure decision; the run that consumes it is a later slice, so there is no new screen yet.

## Driving it with node scratch consumers

From the worktree root, after `npm run build` (see the parent skill), a plain consumer imports the built public entry, replays every fixture row and asserts the two extreme cases:

```js
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolveSelection } from '@byokit/openclaw';

const require = createRequire(import.meta.url);
console.log('resolved ->', require.resolve('@byokit/openclaw')); // must be packages/openclaw/dist/index.js

const fixture = JSON.parse(readFileSync('fixtures/conformance/auto-pick-typescript.json', 'utf8'));
let pass = 0;
for (const c of fixture.cases) {
  const accounts = c.accounts.map((a) => ({ ...a, route: `${a.provider}:test`, label: a.provider, addedAt: 0 }));
  const rooms = (a) => c.rooms[a.id] ?? { left: 'unknown' };
  const models = (a) => (c.models?.[a.id] ?? [{ id: `${a.provider}/m`, available: true }]).map((m) => ({ ...m, name: m.id }));
  const picked = resolveSelection(accounts, c.defaults, c.selection, rooms, fixture.now, models, c.bound);
  const actual = picked.ok ? { ok: true, id: picked.account.id, why: picked.why, how: picked.how, model: picked.model } : { ok: false, code: picked.code };
  if (JSON.stringify(actual) !== JSON.stringify(c.expected)) throw new Error(`${c.name}: ${JSON.stringify(actual)} != ${JSON.stringify(c.expected)}`);
  pass++;
}
console.log(`fixture rows passed -> ${pass}`);

const two = [
  { id: 'a', provider: 'p', name: 'A', state: 'signed_out', billing: 'subscription', route: 'p:test', label: 'p', addedAt: 0 },
  { id: 'b', provider: 'p', name: 'B', state: 'ready', billing: 'subscription', route: 'p:test', label: 'p', addedAt: 0 },
];
const explicit = resolveSelection(two, {}, { account: 'a' }, () => ({ left: 'unknown' }), fixture.now, undefined, ['a']);
if (!explicit.ok || explicit.account.id !== 'a' || explicit.how !== 'chosen') throw new Error('explicit signed-out bound id was replaced');
const both = [
  { id: 'a', provider: 'p', name: 'A', state: 'ready', billing: 'subscription', route: 'p:test', label: 'p', addedAt: 0 },
  { id: 'b', provider: 'p', name: 'B', state: 'ready', billing: 'subscription', route: 'p:test', label: 'p', addedAt: 0 },
];
const fallback = resolveSelection(both, { account: 'b' }, { account: 'default' }, () => ({ left: 'unknown' }), fixture.now, undefined, ['a']);
if (!fallback.ok || fallback.account.id !== 'a' || fallback.how !== 'auto' || fallback.considered.find((r) => r.id === 'b')?.out !== 'bound') throw new Error('default outside bound was not refused');
console.log('DRIVE OK');
```

Extreme cases: an explicit signed-out id inside `bound` is chosen and never replaced, and a default outside `bound` is refused (`out: 'bound'`) with the pick falling back to Auto on the bound account. The resolved path must be inside `packages/openclaw/dist`, never a registry copy.

## Gotchas

- `bound` is absent for an ordinary (unbound) conversation: every account is allowed, so the kit-only rows never change the `@byokit/accounts` behavior.
- An account the selection names still bypasses state and billing, but not `bound` or the demand: a chosen id outside `bound` ends `not_included`.
- The two kit-only sentences a generic refusal would need (`pick.unknownAccount`, `pick.noModel`) are not in the 5.15 table; the failed reasons reuse `auto.none` and `pick.out.model`.
