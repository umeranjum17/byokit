# UI account hooks over live back ends (WP10-S3)

The built `@byokit/ui` keeps the account rows and the run picker live in React: `useAccounts(source)` re-reads with `refresh()` and removes through the back end with `remove(id)`, and `useModelPicker(source)` marks `select()` at once and keeps the caller's selection across refreshes. `accountsSource(accounts, member, room?)` fills the source from a live `@byokit/accounts` member and `cliSource(cli, room?)` from a live `cliAccounts()` kit, each with one line per member; the openclaw adapter stays pending O14. It is headless: the app draws the rows its own way. No credential, engine, network or spend is involved.

## Sub-features

- `useAccounts(source)` returns `{ rows, ready, error, refresh, remove }`: `refresh()` re-reads the source, a room that throws or is absent leaves only its row `Room left unknown`, and a `remove(id)` landing while a refresh is in flight still drops the row (on screen and in the back end); the removal sticks across later refreshes.
- `useModelPicker(source, initial?)` returns `{ rows, picker, selection, ready, error, select, refresh, remove }`: `select(sel)` marks the selection at once from the last read, `refresh()` re-reads accounts, models and Auto's pick together without touching the selection, and `picker` is null until the first refresh resolves.
- `accountsSource(accounts, member, room?)` fits a live `Accounts` structurally (`list()`/`models()`/`pick()`/`remove()`); `cliSource(cli, room?)` fits a live `cliAccounts()` kit and puts each provider's plain name (`Claude`, `Codex`, `Pi`) on its rows. Both type-check against the real kits and run against them.
- The `AccountHooksSource`, `ModelPickerSource`, `MemberAccounts`, `CliAccounts`, `UseAccounts` and `UseModelPicker` types are nameable from the built `@byokit/ui`.

## How to get to it (user POV)

An app that already lists accounts shows them live and lets the person pick the run's account: rows refresh under the list, a failed reading reads `Room left unknown` on that row only, removing an account drops it even mid-refresh, and tapping another account (or Auto) marks it at once. This slice adds no screen of its own, so examples/pwa and examples/expo adopt it later (WP10-S4/S5). On this host the surface is a Node consumer over the built entry, rendered with real React (`react-test-renderer` + `act`, the repo's renderer for headless hooks) against the stand-in OpenAI and a fake native CLI binary.

## Driving it with node scratch consumers

From the worktree root, after `npm run build` (see the parent skill), a plain consumer signs two ChatGPT accounts in through the built `@byokit/accounts`, signs one Claude login in through the built `@byokit/accounts/cli` against a fake binary, and drives the built `@byokit/ui` hooks with real React. This is the same journey `packages/ui/test/accounts-journey.test.ts` runs under `scripts/test.sh`:

```js
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { Accounts, fileStore, portable } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';
import { cliAccounts } from '@byokit/accounts/cli';
import { accountsSource, cliSource, useAccounts, useModelPicker } from '@byokit/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
console.log('ui   ->', require.resolve('@byokit/ui'));   // packages/ui/dist/index.js
console.log('acct ->', require.resolve('@byokit/accounts')); // packages/accounts/dist/index.js

const fail = (m, s) => { throw new Error(`${m}: ${JSON.stringify(s)}`); };
const key = randomBytes(32);
const sealing = {
  encryptString(text) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const sealed = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), sealed]); },
  decryptString(data) { const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28)); return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8'); },
};
const openai = await mockOpenAI();
const accounts = new Accounts({ authBase: openai.base, apiBase: openai.base, app: 'verify ui hooks', store: () => fileStore(new URL('./verify-member.json', import.meta.url).pathname, sealing) }, portable);
try {
  Object.assign(openai.state, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' });
  const a = await accounts.add(1, 'chatgpt', { via: 'code' }); openai.approve(a.signIn.code); await accounts.finished(1, a.id);
  const personal = accounts.view(1, a.id).id;
  Object.assign(openai.state, { accountId: 'umer-work', email: 'umer@work.example', plan: 'plus' });
  const b = await accounts.add(1, 'chatgpt', { via: 'code' }); openai.approve(b.signIn.code); await accounts.finished(1, b.id);
  const work = accounts.view(1, b.id).id;
  await accounts.rename(1, work, 'Work');

  let live;
  const rooms = { [work]: { left: 72, span: 'week' }, [personal]: { left: 30, span: 'week' } };
  const room = (x) => rooms[x.id] ?? { left: 'unknown' };
  const Consumer = ({ source }) => {
    const acc = useAccounts(source); const pick = useModelPicker(source); live = { acc, pick };
    return createElement('pre', null, JSON.stringify({ rows: acc.rows.map((r) => [r.id, r.title, r.detail]), selection: pick.selection, ok: pick.picker?.ok ?? null, account: pick.picker?.account ?? null, selected: pick.picker?.rows.filter((r) => r.selected).map((r) => r.key) ?? null }));
  };
  let root; await act(async () => { root = create(createElement(Consumer, { source: accountsSource(accounts, 1, room) })); });
  const shown = () => JSON.parse(root.root.findByType('pre').children.join(''));
  for (let n = 0; n < 200 && !(shown().account === work); n++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const first = shown();
  if (JSON.stringify(first.rows.find((r) => r[0] === work)) !== JSON.stringify([work, 'ChatGPT · Work', 'Plus · 72% left this week'])) fail('work row', first.rows);
  if (JSON.stringify(first.selection) !== '{"account":"auto"}' || first.selected.join() !== 'auto') fail('auto selection', first);
  await act(async () => { live.pick.select({ account: personal }); });
  if (shown().account !== personal || shown().selected.join() !== personal) fail('select', shown());
  await act(async () => { await live.pick.refresh(); });
  if (shown().account !== personal) fail('selection kept', shown());
  console.log('accounts rows, auto pick and select OK');

  // A room source that fails for one account leaves only that row unknown.
  const failing = accountsSource(accounts, 1, (x) => { if (x.id === work) throw new Error('readings are down'); return room(x); });
  await act(async () => { root.unmount(); root = create(createElement(Consumer, { source: failing })); });
  for (let n = 0; n < 200 && !shown().rows.some((r) => r[0] === work && r[2] === 'Room left unknown'); n++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  if (shown().rows.find((r) => r[0] === work)[2] !== 'Room left unknown' || shown().rows.find((r) => r[0] === personal)[2] !== 'Plus · 30% left this week') fail('failed room', shown().rows);

  // A remove() landing while a refresh is in flight still drops the row, on screen and in the back end.
  const slow = accountsSource(accounts, 1, async (x) => { if (x.id === work) await new Promise((r) => setTimeout(r, 50)); return room(x); });
  await act(async () => { root.unmount(); root = create(createElement(Consumer, { source: slow })); });
  for (let n = 0; n < 200 && !shown().rows.some((r) => r[0] === work); n++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const flight = live.acc.refresh();
  await act(async () => { await live.acc.remove(work); await flight; });
  if (shown().rows.some((r) => r[0] === work) || JSON.stringify((await accounts.list(1)).map((x) => x.id)) !== JSON.stringify([personal])) fail('mid-refresh removal', shown().rows);
  console.log('failed room and mid-refresh removal OK');
  await act(async () => { root.unmount(); });

  const dir = new URL('./verify-cli/', import.meta.url).pathname; mkdirSync(dir, { recursive: true });
  const bin = `${dir}claude`; writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:true,email:'alice.work@example.test',subscriptionType:'pro'}));\n`, { mode: 0o755 });
  const kit = cliAccounts({ stateDir: `${dir}plans`, bins: { claude: bin }, env: { HOME: `${dir}home`, PATH: '/unused' } });
  const added = await kit.add('claude');
  if (spawnSync('/bin/sh', ['-c', added.signIn.shell], { encoding: 'utf8' }).status !== 0) fail('cli sign-in', null);
  await kit.rename(added.account.id, 'Work');
  const cliRows = await (async () => {
    let renderer; const seen = cliSource(kit, () => ({ left: 72, span: 'week' }));
    const Only = () => { const acc = useAccounts(seen); return createElement('pre', null, JSON.stringify(acc.rows.map((r) => [r.id, r.title, r.detail]))); };
    await act(async () => { renderer = create(createElement(Only, null)); });
    for (let n = 0; n < 200 && !renderer.root.findByType('pre').children.join('').includes('Claude'); n++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    return JSON.parse(renderer.root.findByType('pre').children.join(''));
  })();
  if (JSON.stringify(cliRows) !== JSON.stringify([[added.account.id, 'Claude · Work', 'Pro · 72% left this week']])) fail('cli row', cliRows);
  console.log('cli adapter row OK');
  console.log('DRIVE OK');
} finally { accounts.stop(); await openai.close(); }
```

Run it from a `$scratch_dir` (see the parent skill) so the bare imports resolve to the workspace: `chmod 0700 "$scratch_dir"` first (`fileStore` requires a private folder), then `node consumer.mjs` prints both resolved paths inside `packages/*/dist`, the exact rows (`ChatGPT · Work` / `Plus · 72% left this week`, `Claude · Work` / `Pro · 72% left this week`), and `DRIVE OK`. The resolved paths must be inside `packages/*/dist`, never a registry copy. The extremes in the same run are the explicit `select()` marking (and surviving a refresh), a failing room leaving only its row unknown, and a `remove()` landing mid-refresh dropping the row — each failing the run when wrong; the journey test covers all three against the same live kits.

## Gotchas

- Real React only: the hooks run under `react-test-renderer` + `act` (the repo's installed renderer for headless hooks), never under the old `react-stub` synchronous mock. Set `IS_REACT_ACT_ENVIRONMENT = true` in plain consumers.
- This is not a visual change: there is no screen, so there are no narrow/larger-text screenshots — the consumer's exact rendered text in the drive output is the proof.
- `@byokit/ui/accounts` stays a portable entry: the hooks live in `@byokit/ui` (which already depends on React) and the adapters restate `@byokit/accounts` structurally, so no account import reaches the portable bundle.
- A `remove()` that fails unpins the id and rethrows, so a later `refresh()` brings the row back; call `refresh()` after a successful remove when other rows' rooms must be fresh.
- The openclaw adapter is pending O14: do not stub one that pretends to work.
