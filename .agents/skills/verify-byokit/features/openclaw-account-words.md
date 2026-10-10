# OpenClaw account words and restated account types (5.15)

The built `@byokit/openclaw` publishes the section 5.15 account vocabulary: the restated `Account`, `AccountPick`, `Considered`, `RunSelection` and `MoveResult` shapes (structural copies of `@byokit/accounts`, never imported, plus the kit-only `bound`/`paid` members), and the `auto.*`, `room.*`, `pick.*`, `ago.*` and `account.*` sentences in `words.json` so an app can say why an account was chosen or refused. No credential, provider, engine or spend is involved.

## Sub-features

- `words(key, vars)` returns the exact sentence from `src/words.json`; `{name}`, `{provider}`, `{room}`, `{left}` and the rest are filled by the caller, and `%` is rendered by the kit, never stored. Missing vars are left as-is; an unknown placeholder never crashes.
- The five restated types are nameable from the built package entry (`import type { Account, AccountPick, Considered, RunSelection, MoveResult } from '@byokit/openclaw'`).
- `RunSpec` and `RunEnd` are unchanged in this slice.

## How to get to it (user POV)

A host app signs a member in and, at run start, resolves which account a conversation uses. It shows the kit's sentence for the outcome (the chosen account, or, for a refusal, why). This slice supplies that vocabulary and those shapes; later account surfaces consume them, so there is no new screen yet.

## Driving it with node scratch consumers

From the worktree root, after `npm run build` (see the parent skill), a plain consumer imports the built public entry and reads the account words:

```js
import { createRequire } from 'node:module';
import { words } from '@byokit/openclaw';

const require = createRequire(import.meta.url);
console.log('resolved ->', require.resolve('@byokit/openclaw')); // must be packages/openclaw/dist/index.js

const sentence = words('account.bound', { name: 'Work' });
if (sentence !== 'This conversation uses Work. Move it to switch accounts.') throw new Error(sentence);
// '%' is rendered by the kit, so no sentence carries it.
for (const key of ['account.bound', 'account.paid', 'room.session', 'auto.room', 'pick.why.most_room']) {
  if (words(key, { name: 'Work', provider: 'ChatGPT', room: '82 percent left this week', left: '82 percent' }).includes('%')) throw new Error(key);
}
console.log('DRIVE OK');
```

`node scratch.verify-byokit.wp8s2/consumer.mjs` prints `resolved -> .../packages/openclaw/dist/index.js`, every sentence and `DRIVE OK`; the resolved path must be inside `packages/openclaw/dist`, never a registry copy. The extreme case is the `%` scan: a percent sign reaching a stored word fails the run.

## Gotchas

- The words live in `src/words.json`; `test/words.test.ts` holds a verbatim copy, so a new key changes both files together.
- `%` is banned in `words.json`; the kit appends the sign when it renders `{left}`.
- No `@byokit/accounts` import (D3): the shapes are restated, so a change there does not flow through automatically.
