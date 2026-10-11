# The run picker and the Move target (WP10-S2)

The built `@byokit/ui/accounts` turns a run's account choice into the rows a settings or run sheet draws: an `Auto — most room left` row carrying the pick's own reason, then one plain row per account with its model rows and the selection marked, and honest why/until words for anyone who cannot be used right now. It also names the account a running session should move to. It is headless and framework-free: an app fills it from its own `@byokit/accounts` `list()`/`models()` and the pick `resolveSelection` already made; no credential, engine, network or spend is involved.

## Sub-features

- `modelPicker(accounts, models, sel, auto, now?)` returns a `PickerView`: `rows` starts with the `Auto — most room left` row (`detail` is the pick's `reason`, `disabled` with a typed `disabledReason` when no account can be named), then one `PickerRow` per account in list order. Each account row carries that account's `models` (each `PickerModel` with `available`/`why`/`until`, and `selected` on the run's model), the selection itself `selected`, and `out`/`until` from the pick's own explanation.
- A signed-out explicit pick is marked `selected`, reads `Sign in first`, is never `ok`, and never falls back to another account. When every account is signed out the Auto row is `disabled` with the pick's typed code (`none`).
- `bestMoveTarget(accounts, room, current, now?)` returns the account `@byokit/accounts` `chooseAccount` would pick — the roomiest signed-in subscription account you are not already on — or `undefined` with one account, with only signed-out peers, when nobody has room left, or when the list is API keys only.
- `moveWords(name, moved?)` is the Move sheet's one sentence: `Move to Work` or `Couldn't move to Work`.
- The `ModelInfo`, `RunSelection`, `Pick`, `PickWhy`, `PickOut`, `PickerModel`, `PickerRow` and `PickerView` types are restated structurally from `@byokit/accounts` (D3), nameable from `@byokit/ui/accounts`.

## How to get to it (user POV)

An app that already signs people in and lets them choose an account shows a picker: `Auto` first, then each account with its models, and a Move suggestion when a running session's account is low. This slice adds no screen of its own, so examples/pwa and examples/expo adopt it later (WP10-S4/S5). On this host the surface is a Node consumer over the built entry, driven against the shared parity table and the stand-in chooser.

## Driving it with node scratch consumers

From the worktree root, after `npm run build` (see the parent skill), a plain consumer reads the built `@byokit/ui/accounts` picker and the built `@byokit/accounts` chooser over the shared parity table, then checks a signed-out explicit pick and the Move target. This is the same journey `packages/ui/test/accounts-journey.test.ts` runs under `scripts/test.sh`:

```js
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolveSelection } from '@byokit/accounts';
import { bestMoveTarget, modelPicker, moveWords } from '@byokit/ui/accounts';

const require = createRequire(import.meta.url);
console.log('ui   ->', require.resolve('@byokit/ui/accounts'));   // packages/ui/dist/accounts.js
console.log('acct ->', require.resolve('@byokit/accounts'));     // packages/accounts/dist/index.js

const fixture = JSON.parse(readFileSync(new URL('../fixtures/conformance/auto-pick-typescript.json', import.meta.url), 'utf8'));
const fail = (m) => { throw new Error(m); };
const toAccounts = (c) => c.accounts.map((a) => ({ id: a.id, provider: a.provider, name: a.name, state: a.state, billing: a.billing, ...(a.until !== undefined ? { until: a.until } : {}) }));
const toModels = (c) => Object.fromEntries(c.accounts.map((a) => [a.id, (c.models?.[a.id] ?? [{ id: `${a.provider}/m`, available: true }]).map((m) => ({ id: m.id, name: m.id, available: m.available }))]));
const roomsOf = (c) => (a) => c.rooms[a.id] ?? { left: 'unknown' };
const modelsOf = (models) => (a) => models[a.id] ?? [];

let autoRows = 0;
for (const c of fixture.cases) {
  if (c.kitOnly || c.selection.account !== 'auto') continue;
  const accounts = toAccounts(c), models = toModels(c);
  const pick = resolveSelection(accounts, c.defaults, c.selection, roomsOf(c), fixture.now, modelsOf(models));
  const view = modelPicker(accounts, models, c.selection, pick, fixture.now);
  if (view.rows[0].title !== 'Auto — most room left') fail(`${c.name}: auto title`);
  if (view.rows[0].detail !== pick.reason) fail(`${c.name}: auto reason`);
  if (view.ok !== pick.ok) fail(`${c.name}: ok`);
  if (pick.ok && (view.account !== pick.account.id || view.model !== pick.model)) fail(`${c.name}: chosen account/model`);
  if (!pick.ok && (view.rows[0].disabled !== true || view.rows[0].disabledReason !== pick.code)) fail(`${c.name}: typed disabled reason`);
  for (const [id, expected] of Object.entries(c.considered ?? {})) {
    const row = view.rows.find((r) => r.key === id);
    if ((row.out ?? null) !== (expected.out ?? null)) fail(`${c.name}: ${id} why`);
    if (expected.until !== undefined && row.until !== expected.until) fail(`${c.name}: ${id} until`);
  }
  autoRows++;
}
console.log(`auto rows matched: ${autoRows}`);

// bestMoveTarget agrees with Auto on every row it can act on, and stays undefined otherwise.
let moves = 0;
for (const c of fixture.cases) {
  if (c.kitOnly) continue;
  const accounts = toAccounts(c);
  const pick = resolveSelection(accounts, {}, { account: 'auto' }, roomsOf(c), fixture.now, modelsOf(toModels(c)));
  if (!pick.ok) continue;
  const other = accounts.find((a) => a.id !== pick.account.id);
  if (!other) continue;
  const r = c.rooms[pick.account.id];
  if (r && r.left !== 'unknown' && r.left <= 0 && !(typeof r.resetsAt === 'number' && r.resetsAt <= fixture.now)) continue;
  if (bestMoveTarget(accounts, c.rooms, other.id, fixture.now) !== pick.account.id) fail(`${c.name}: move target`);
  moves++;
}
console.log(`move targets agreed: ${moves}`);

// An explicit signed-out pick says Sign in first and never falls back; all signed out disables Auto typed.
const models = { a: [], b: [{ id: 'gpt-6-sol', name: 'Sol', available: true }] };
const accounts = [
  { id: 'a', provider: 'chatgpt', name: 'Personal', state: 'signed_out', billing: 'subscription' },
  { id: 'b', provider: 'chatgpt', name: 'Work', state: 'ready', billing: 'subscription' },
];
const auto = resolveSelection(accounts, {}, { account: 'auto' }, () => ({ left: 'unknown' }), 1000, modelsOf(models));
const view = modelPicker(accounts, models, { account: 'a' }, auto, 1000);
const aRow = view.rows.find((r) => r.key === 'a');
if (!aRow.selected || aRow.detail !== 'Sign in first' || view.ok) fail('signed-out pick words');
if (view.rows.find((r) => r.key === 'b').selected || view.rows[0].selected) fail('signed-out pick fell back');
const none = resolveSelection(accounts.map((a) => ({ ...a, state: 'signed_out' })), {}, { account: 'auto' }, () => ({ left: 'unknown' }), 1000, modelsOf(models));
const disabled = modelPicker(accounts.map((a) => ({ ...a, state: 'signed_out' })), models, { account: 'auto' }, none, 1000);
if (!disabled.rows[0].disabled || disabled.rows[0].disabledReason !== 'none') fail('auto not disabled typed');

// Nowhere to move: one account, only signed-out peers, no room, or API keys alone.
const sub = (over = {}) => ({ id: 'a', provider: 'p', name: 'A', state: 'ready', billing: 'subscription', ...over });
const noMove = [
  bestMoveTarget([sub()], {}, 'a'),
  bestMoveTarget([sub(), sub({ id: 'b', state: 'signed_out' })], {}, 'a'),
  bestMoveTarget([sub(), sub({ id: 'b' })], { a: { left: 0, span: 'week' }, b: { left: 0, span: 'week' } }, 'a', 1000),
  bestMoveTarget([sub({ billing: 'api' }), sub({ id: 'b', billing: 'api' })], {}, ''),
];
if (noMove.some((t) => t !== undefined)) fail(`move target should be undefined: ${JSON.stringify(noMove)}`);
console.log(moveWords('Work'), '/', moveWords('Work', false));
console.log('DRIVE OK');
```

Run it from a `$scratch_dir` (see the parent skill) so the bare imports resolve to the workspace: `node consumer.mjs` prints both resolved paths inside `packages/*/dist`, the count of parity rows whose Auto row and Move target matched, `Move to Work / Couldn't move to Work`, and `DRIVE OK`. The resolved paths must be inside `packages/*/dist`, never a registry copy.

## Gotchas

- `@byokit/ui/accounts` stays a portable entry: `modelPicker`/`bestMoveTarget` restate `@byokit/accounts` structurally and import nothing from it at runtime, so the react-native bundle check stays green.
- The picker reads the pick's `considered` rows for each account's `out`/`until`; a hand-made `Pick` without them falls back to the account's own state (`state`/`resting`), and a `resting` `until` that has passed reads usable again.
- An explicit signed-out pick is shown as `Sign in first` and never replaced by another account or by Auto.
- `bestMoveTarget` mirrors `chooseAccount` (subscriptions only, most room, unknown above exhausted, earliest reset then list order). It never names the current account back to itself.
- Move words carry no `%` and no code, id or jargon; the same words pass the repo's plain-words scan.
