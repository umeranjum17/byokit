# Cloud roster (several accounts and computers)

An app whose person has two Boat accounts and three computers lists, selects and manages them through `roster()` from the built `@byokit/cloud`: a non-secret roster in the app's store, each key in its key store, one Provider per account, and one `Machine` per managed computer. Waking, sleeping or removing one touches no other.

## Sub-features

- `roster-accounts`: `add` checks a key with the provider and keeps it only in the key store; the first account is active; `select` changes it; a bad key is the typed `unauthorized`.
- `roster-list`: `list(account)` refs carry `subdomain`, `state` and `latestSnapshot` (`at`, `status`) from Boat's list row.
- `roster-machines`: `fresh().create` joins the roster pinned to its account; `machine(id).sleep()`/`wake()` change only that computer and send nothing to the other account's bench.
- `roster-remove`: `machine(id).remove(id)` deletes one computer; `remove(account)` forgets an account, its key and its machines; an unmanaged id is the typed `no-machine`.

## How to get to it (user POV)

- The consumer imports `boat` and `roster` from `@byokit/cloud` and `startFakeSandboxServer` from `@byokit/cloud/testing`; two loopback Boat benches stand in for two accounts. No account, key, VM or spend.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-cloud-roster.mjs"` (below). Import public entries only.
- **Run and capture.** `feature=cloud-roster; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-cloud-roster.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `accounts` lists both with `active: acct-work`; `listed` shows each computer's state, subdomain and `latestSnapshot`; `after-sleep` shows only `beta` asleep and `home-requests-during-sleep: 0`; `after-remove` lists the two left; the error leg prints `unmanaged: "no-machine"` and `refused-add: "unauthorized"`.

```js
import { boat, roster } from '@byokit/cloud';
import { startFakeSandboxServer } from '@byokit/cloud/testing';

const out = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const servers = {
  'key-work': await startFakeSandboxServer({ key: 'key-work', accountId: 'acct-work', idPrefix: 'wk' }),
  'key-home': await startFakeSandboxServer({ key: 'key-home', accountId: 'acct-home', idPrefix: 'hm' }),
};
try {
  const secrets = new Map();
  const keys = { get: async (a) => secrets.get(a) ?? null, set: async (a, k) => void secrets.set(a, k), delete: async (a) => void secrets.delete(a) };
  let saved = null;
  const r = roster({
    store: { load: async () => saved, save: async (x) => void (saved = structuredClone(x)) },
    keys,
    provider: ({ label, key }) => boat({
      baseUrl: 'http://boat.test/api/v1', label, prices: [], key,
      fetch: async (url, init) => {
        const s = servers[new Headers(init.headers).get('authorization')?.replace('Bearer ', '')];
        return s ? fetch(String(url).replace('http://boat.test/api/v1', s.url), init) : new Response('{}', { status: 401 });
      },
    }),
  });
  try { await r.add({ key: 'key-nope' }); } catch (e) { out('refused-add', e.code); }
  await r.add({ key: 'key-work', label: 'Work' });
  await r.add({ key: 'key-home', label: 'Home' });
  out('accounts', { all: (await r.accounts()).map((a) => a.label), active: (await r.active()).id });
  const mk = async (name) => (await (await r.fresh()).create({ name, size: 'small', keepCopies: true }));
  const alpha = await mk('alpha');
  const beta = await mk('beta');
  await r.select('acct-home');
  const gamma = await mk('gamma');
  out('listed', (await r.list('acct-work')).map((m) => [m.id, m.state, m.subdomain, m.latestSnapshot]));
  const homeBefore = servers['key-home'].requests.length;
  await (await r.machine(beta.id)).sleep();
  out('after-sleep', { alpha: servers['key-work'].getState(alpha.id), beta: servers['key-work'].getState(beta.id), gamma: servers['key-home'].getState(gamma.id) });
  out('home-requests-during-sleep', servers['key-home'].requests.length - homeBefore);
  await (await r.machine(beta.id)).wake();
  await (await r.machine(alpha.id)).remove(alpha.id);
  out('after-remove', (await r.machines()).map((m) => m.id));
  try { await r.machine(alpha.id); } catch (e) { out('unmanaged', e.code); }
  out('roster-holds-secret', JSON.stringify(saved).includes('key-work'));
} finally {
  for (const s of Object.values(servers)) await s.close();
}
```

## Gotchas

- Import from `@byokit/cloud` and `@byokit/cloud/testing` only; never `packages/cloud/src`.
- The roster record must hold no key: `roster-holds-secret` prints `false`.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/cloud-roster/` evidence survives.
