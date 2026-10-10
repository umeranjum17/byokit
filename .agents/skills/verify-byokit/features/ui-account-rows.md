# UI account rows and name suggestions (WP10-S1)

The built `@byokit/ui/accounts` turns what an app already lists into the rows a person sees: the provider and the person's own name for an account (`ChatGPT · Work`), then the plan and the room left (`Plus · 72% left this week`), or the honest words for a sign-in state that is not ready ("Checking…", "Cooling down", "Not signed in", "Sign in again", "Not in your plan"). It is headless: an app builds an `AccountsSource` from its own back end and draws the rows its own way. No credential, provider engine, network or spend is involved; the room reading is the app's own.

## Sub-features

- `accountRows(accounts, room, now)` returns one `AccountRow` per account: `title`, `detail`, `state`, `billing`, `low` (room left at or below 20%, exactly 20 included, false for an unknown room), and, when it helps, `action` (`sign_in` for `signed_out`/`needs_again`, `wait` plus the `until` refill time for `resting`). A `resting` account whose `until` has passed reads `ready` again, exactly as Auto treats it.
- `rowsOf(source, now)` awaits an `AccountsSource` (`accounts()` and `room(account)`); a room that throws or is absent leaves only that row `Room left unknown`, never breaking the list.
- `nameSuggestions(email, taken, provider?)` offers up to three untaken names from an email's local part (deduped case-insensitively against `taken`), falling back to the provider's name when there is no email. The email itself is never offered, and a name that is an email never becomes a title.
- The `Account`, `AccountRow`, `AccountAction`, `AccountsSource`, `Billing`, `Room`, `RoomSpan` and `SignInState` types are restated structurally from `@byokit/accounts` (D3), nameable from the built `@byokit/ui` and `@byokit/ui/accounts` entries.

## How to get to it (user POV)

An app that already signs people in shows a list of their accounts. `accountRows` is the words and flags for that list; this slice adds no screen of its own, so examples/pwa and examples/expo adopt it later (WP10-S4/S5). On this host the surface is a Node consumer over the built entry, driven against the stand-in OpenAI.

## Driving it with node scratch consumers

From the worktree root, after `npm run build` (see the parent skill), a plain consumer signs two ChatGPT accounts in through the built `@byokit/accounts` and reads the built `@byokit/ui/accounts` rows. This is the same journey `packages/ui/test/accounts-journey.test.ts` runs under `scripts/test.sh`:

```js
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Accounts, fileStore, portable } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';
import { accountRows, nameSuggestions, rowsOf } from '@byokit/ui/accounts';

const require = createRequire(import.meta.url);
console.log('ui   ->', require.resolve('@byokit/ui/accounts'));      // packages/ui/dist/accounts.js
console.log('acct ->', require.resolve('@byokit/accounts'));        // packages/accounts/dist/index.js

const key = randomBytes(32);
const sealing = {
  encryptString(text) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const sealed = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), sealed]); },
  decryptString(data) { const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28)); return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8'); },
};

const fail = (message) => { throw new Error(message); };
const openai = await mockOpenAI();
const accounts = new Accounts({ authBase: openai.base, apiBase: openai.base, app: 'verify ui accounts', store: () => fileStore(new URL('./verify-member.json', import.meta.url).pathname, sealing) }, portable);
try {
  Object.assign(openai.state, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' });
  const a = await accounts.add(1, 'chatgpt', { via: 'code' }); openai.approve(a.signIn.code); await accounts.finished(1, a.id);
  const personal = accounts.view(1, a.id).id;
  Object.assign(openai.state, { accountId: 'umer-work', email: 'umer@work.example', plan: 'plus' });
  const b = await accounts.add(1, 'chatgpt', { via: 'code' }); openai.approve(b.signIn.code); await accounts.finished(1, b.id);
  const work = accounts.view(1, b.id).id;
  await accounts.rename(1, work, 'Work');

  const rooms = { [work]: { left: 72, span: 'week' }, [personal]: { left: 30, span: 'week' } };
  const rows = await rowsOf({ accounts: () => accounts.list(1), room: (x) => rooms[x.id] ?? { left: 'unknown' } }, Date.now());
  const workRow = rows.find((r) => r.id === work);
  if (!workRow || workRow.title !== 'ChatGPT · Work' || workRow.detail !== 'Plus · 72% left this week' || workRow.low) fail(JSON.stringify(workRow));
  if (JSON.stringify(rows).includes('@')) fail('an email reached a row');
  console.log(rows.map((r) => `${r.title} — ${r.detail}`).join('\n'));

  // Extremes, over the pure rows: low is set at exactly 20 and not 21; an unknown room is never low or planned.
  const row = (over, left, span = 'week') => accountRows([{ id: 'x', provider: 'chatgpt', name: 'ChatGPT', label: 'ChatGPT', state: 'ready', billing: 'subscription', ...over }], () => left === 'unknown' ? { left } : { left, span }, 1000)[0];
  if (row({ plan: 'plus' }, 20).low !== true || row({ plan: 'plus' }, 21).low !== false) fail('low threshold');
  if (row({ plan: 'plus' }, 'unknown').detail !== 'Room left unknown') fail('unknown room words');
  if (row({ state: 'signed_out' }, 50).action !== 'sign_in' || row({ state: 'resting', until: 9e6 }, 0).action !== 'wait') fail('actions');
  if (JSON.stringify(accountRows([{ id: 'x', provider: 'chatgpt', name: 'ChatGPT', state: 'ready', billing: 'subscription', token: 'sk-canary' }], () => ({ left: 50, span: 'week' }), 1000)).includes('sk-canary')) fail('credential reached a row');
  console.log('suggestions ->', nameSuggestions('umer@example.com', ['Umer']).join(', '));
  if (nameSuggestions('umer@example.com', ['uMeR'])[0] !== 'Umer 2') fail('dedupe');
  console.log('DRIVE OK');
} finally { accounts.stop(); await openai.close(); }
```

Run it from a `$scratch_dir` (see the parent skill) so the bare imports resolve to the workspace: `node consumer.mjs` prints both resolved paths inside `packages/*/dist`, one row per account (`ChatGPT` and `ChatGPT · Work`), and `DRIVE OK`. The resolved paths must be inside `packages/*/dist`, never a registry copy. The extremes in the same run are the account-name-as-email title, the 20/21 `low` boundary, the unknown-room words and the credential canary, each failing the run when wrong.

## Gotchas

- `@byokit/ui/accounts` is a portable entry: no Node and no React. Keep it that way; `test/portable.test.ts` and the entry's own react-native bundle check fail otherwise.
- An email never reaches a row or a title. `titleOf` drops an account name that contains `@`, and `nameSuggestions` offers only the local part.
- Room words carry no `%`: the percentage sign is appended at render (`{left}` → `72%`), so the same words pass the repo's plain-words scan.
- `accountRows` reads only the fields it names, so a credential on an account object never reaches a row (D3); extra fields are ignored, not copied.
- The type restatement is deliberate: a change to `@byokit/accounts`' `Account`/`Room` does not flow through automatically.
