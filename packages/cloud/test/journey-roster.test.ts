// Consumer journey for the roster (docs/cloud-kit.md 5.14): a person with two cloud accounts and three
// managed computers lists, selects, wakes and sleeps one without touching the others, and removes one.
// Two loopback Boat benches stand in for the two accounts; no network, key or real machine is used.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { boat, roster, MachineError } from '@byokit/cloud';
import type { KeyStore, MachineRef, Price, RosterRecord, RosterStore } from '@byokit/cloud';
import { startFakeSandboxServer } from '@byokit/cloud/testing';
import type { SandboxServer } from '@byokit/cloud/testing';

const prices = (): readonly Price[] => [{
  size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0,
  currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://boat.test/prices', checked: '2026-09-29',
}];

const rejects = async (p: Promise<unknown>, code: string): Promise<void> => {
  try {
    await p;
  } catch (e) {
    assert.equal((e as MachineError).code, code);
    return;
  }
  assert.fail(`expected rejection with ${code}`);
};

test('two accounts and three computers: list, select, wake and sleep one, remove one', async () => {
  const servers: Record<string, SandboxServer> = {
    'key-work': await startFakeSandboxServer({ key: 'key-work', accountId: 'acct-work', idPrefix: 'wk' }),
    'key-home': await startFakeSandboxServer({ key: 'key-home', accountId: 'acct-home', idPrefix: 'hm' }),
  };
  after(async () => {
    for (const s of Object.values(servers)) await s.close();
  });
  const seen = (): Record<string, number> => Object.fromEntries(Object.entries(servers).map(([k, s]) => [k, s.requests.length]));
  const touched = (key: string, since: number, id: string): number =>
    servers[key].requests.slice(since).filter((r) => r.path.includes(id)).length;

  // The key store holds the secrets; the roster store is what an app persists, and holds none.
  const secrets = new Map<string, string>();
  const keys: KeyStore = {
    get: async (a) => secrets.get(a) ?? null,
    set: async (a, k) => void secrets.set(a, k),
    delete: async (a) => void secrets.delete(a),
  };
  let saved: RosterRecord | null = null;
  const store: RosterStore = { load: async () => saved, save: async (r) => void (saved = structuredClone(r)) };
  const open = () => roster({
    store,
    keys,
    provider: ({ label, key }) => boat({
      baseUrl: 'http://boat.test/api/v1', label, prices: prices(), key,
      // Each account's key reaches its own bench, as each account reaches its own provider.
      fetch: (async (url: unknown, init: RequestInit) => {
        const auth = new Headers(init.headers).get('authorization') ?? '';
        const server = servers[auth.replace('Bearer ', '')];
        if (server === undefined) return new Response('{}', { status: 401 });
        return fetch(String(url).replace('http://boat.test/api/v1', server.url), init);
      }) as typeof fetch,
    }),
  });

  let r = open();
  assert.equal(await r.active(), null);
  await rejects(r.provider(), 'wrong-account');
  await rejects(r.add({ key: 'key-nope' }), 'unauthorized');

  // Two accounts; the first becomes active, and the roster holds no key.
  const work = await r.add({ key: 'key-work', label: 'Work' });
  const home = await r.add({ key: 'key-home', label: 'Home' });
  assert.deepEqual([work.id, home.id], ['acct-work', 'acct-home']);
  assert.equal((await r.active())?.id, 'acct-work');
  assert.equal((await r.provider('acct-work')) === (await r.provider('acct-home')), false);
  assert.equal(JSON.stringify(saved).includes('key-work'), false);
  assert.equal(secrets.get('acct-home'), 'key-home');

  // Three computers: two on the active account, one on the other after select.
  const alpha = await (await r.fresh()).create({ name: 'alpha', size: 'small', keepCopies: true });
  const beta = await (await r.fresh()).create({ name: 'beta', size: 'small', keepCopies: true });
  await r.select('acct-home');
  const gamma = await (await r.fresh()).create({ name: 'gamma', size: 'small', keepCopies: true });
  assert.deepEqual([alpha.account, beta.account, gamma.account], ['acct-work', 'acct-work', 'acct-home']);
  assert.deepEqual((await r.machines()).map((m) => m.id), [alpha.id, beta.id, gamma.id]);
  assert.deepEqual((await r.machines('acct-home')).map((m) => m.id), [gamma.id]);
  await rejects(r.select('acct-nope'), 'wrong-account');

  // list() carries the subdomain, the state and the latest copy where the wire returns them.
  const listed = await r.list('acct-work');
  assert.deepEqual(listed.map((m) => [m.id, m.state, m.subdomain, m.latestSnapshot]), [
    [alpha.id, 'on', `${alpha.id}-box`, { at: null, status: null }],
    [beta.id, 'on', `${beta.id}-box`, { at: null, status: null }],
  ]);
  assert.deepEqual((await r.list()).map((m) => m.id), [gamma.id]);
  await rejects(r.manage({ ...listed[0], account: 'acct-nope' }), 'wrong-account');
  await rejects(r.machine(`${gamma.id}-nope`), 'no-machine');

  // Sleep and wake beta: alpha, gamma and the other account's bench are not asked anything.
  const mBeta = await r.machine(beta.id);
  const before = seen();
  await mBeta.sleep();
  assert.equal(servers['key-work'].getState(beta.id), 'archived');
  assert.equal(await mBeta.state(), 'asleep');
  assert.equal(servers['key-work'].getState(alpha.id), 'ready');
  assert.equal(servers['key-home'].getState(gamma.id), 'ready');
  assert.equal(seen()['key-home'], before['key-home']);
  assert.equal(touched('key-work', before['key-work'], alpha.id), 0);
  await mBeta.wake();
  assert.equal(await mBeta.state(), 'on');
  assert.equal(seen()['key-home'], before['key-home']);
  assert.equal(touched('key-work', before['key-work'], alpha.id), 0);

  // A saved copy shows in the next list.
  const copy = await mBeta.snapshot();
  const [, relisted] = await r.list('acct-work');
  assert.deepEqual(relisted.latestSnapshot, { at: (await mBeta.snapshots())[0].at, status: 'completed' });
  assert.equal(copy.id, (await mBeta.snapshots())[0].id);

  // A restarted app finds the same accounts, selection, machines and refs, and keeps driving them.
  r = open();
  assert.equal((await r.active())?.id, 'acct-home');
  assert.deepEqual((await r.accounts()).map((a) => a.label), ['Work', 'Home']);
  assert.deepEqual(await r.machines(), [alpha, beta, gamma]);
  assert.equal(await (await r.machine(gamma.id)).state(), 'on');

  // Remove one computer: only it goes, on the provider and in the roster.
  const mAlpha = await r.machine(alpha.id);
  await rejects(mAlpha.remove(beta.id), 'confirm');
  await mAlpha.remove(alpha.id);
  assert.equal(servers['key-work'].getState(alpha.id), null);
  assert.equal(servers['key-work'].getState(beta.id), 'ready');
  assert.deepEqual((await r.machines()).map((m) => m.id), [beta.id, gamma.id]);
  await rejects(mAlpha.state(), 'no-machine');

  // Stop managing one: the computer stays on the provider. Forget an account: its key and machines go.
  await r.unmanage(gamma.id);
  assert.equal(servers['key-home'].getState(gamma.id), 'ready');
  await r.remove('acct-home');
  assert.equal(secrets.has('acct-home'), false);
  assert.equal((await r.active())?.id, 'acct-work');
  assert.deepEqual((await r.machines()).map((m) => m.id), [beta.id]);
  assert.equal(await (await r.machine(beta.id)).state(), 'on');
});
