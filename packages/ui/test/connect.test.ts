// The connect view over every route the kits list (D18): grouped by how the person pays, plans alone offered by
// default, no API, cloud, local, server or unknown-billing row ever in Plans, plain words for every readiness, and
// nothing but the listed fields (never a credential) in the view. Checked against a synthetic 100-route table, the
// shared fixture, and the kits' own pinned tables on each platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import WORDS from '../src/words.json' with { type: 'json' };
import { routeReadiness, routes as accountRoutes, type Route as AccountRoute, type RouteHost } from '../../accounts/src/catalogue.ts';
import { routes as openclawRoutes } from '../../openclaw/src/routes.ts';
import { connectStep, connectView, signInFor, type ConnectRoute, type ConnectStep, type ConnectView } from '../src/connect.ts';

const PLAIN = new RegExp(JSON.parse(readFileSync(new URL('../../../fixtures/conformance/plain-words.json', import.meta.url), 'utf8')).pattern, 'i');
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/account-routes-typescript.json', import.meta.url), 'utf8')) as {
  vocabulary: Record<'via' | 'billing' | 'readiness', string[]>;
  routes: AccountRoute[];
  discovery: { name: string; host: RouteHost; offered: string[] }[];
};
const { via: VIAS, billing: BILLINGS, readiness: READINESS } = fixture.vocabulary as { via: ConnectRoute['via'][]; billing: ConnectRoute['billing'][]; readiness: ConnectRoute['readiness'][] };
const ORDER = ['plans', 'perUse', 'local', 'server', 'cloud', 'other', 'services'];
const rows = (v: ConnectView) => v.groups.flatMap((g) => g.rows);
const declaredDefault = (r: ConnectRoute) => r.offer === 'default' || r.offer === true || r.offerPolicy === 'default';

/** 100 routes crossing every via, billing and readiness, with a default offer claimed on rows of every billing
 *  (some of them wrongly), openclaw's boolean/offerPolicy spelling mixed in, and some non-chat services. */
const synthetic: ConnectRoute[] = Array.from({ length: 100 }, (_, i) => {
  const billing = BILLINGS[i % BILLINGS.length];
  const offer = i % 4 === 0 ? 'default' : billing === 'subscription' && i % 3 !== 0 ? 'default' : 'explicit';
  return {
    id: `p${i}:${VIAS[i % VIAS.length]}`, provider: `p${i}`, name: `Plan ${i}`, company: `Company ${i}`,
    via: VIAS[i % VIAS.length], billing, readiness: READINESS[i % READINESS.length],
    ...(i % 6 === 5 ? { offer: offer === 'default', offerPolicy: offer, upstream: { surface: 'openclaw' as const } } : { offer, upstream: { surface: 'accounts' as const } }),
    ...(i % 13 === 0 ? { group: 'services' as const } : {}),
  };
});

/** Every invariant the view keeps, whatever the routes. */
function invariants(routes: readonly ConnectRoute[], view: ConnectView) {
  const listed = rows(view);
  assert.equal(listed.length, routes.length, 'every route is listed, unavailable ones too');
  assert.equal(new Set(listed.map((r) => r.key)).size, routes.length, 'row keys are unique');
  assert.deepEqual(view.groups.map((g) => g.id), ORDER.filter((id) => view.groups.some((g) => g.id === id)), 'groups keep their order');
  for (const g of view.groups) assert.ok(g.rows.length && g.title && g.note, g.id);
  for (const [i, r] of routes.entries()) {
    const row = listed.find((x) => x.key === `${r.upstream?.surface ?? ''}/${r.id}`)!;
    assert.ok(row, r.id);
    if (row.group === 'plans') {
      assert.equal(r.billing, 'subscription', `${r.id}: only a plan is in Plans`);
      assert.ok(declaredDefault(r), `${r.id}: only a default row is in Plans`);
      assert.ok(!['cloud', 'local', 'endpoint'].includes(r.via), `${r.id}: cloud, local and server rows are always explicit`);
    } else if (r.billing === 'subscription' && declaredDefault(r) && r.group !== 'services' && !['cloud', 'local', 'endpoint'].includes(r.via)) assert.fail(`${r.id}: a default plan left Plans`);
    assert.equal(row.offered, row.group === 'plans' && r.readiness === 'ready', `${r.id}: offered means a ready plan (${i})`);
    if (row.offered) assert.equal(r.billing, 'subscription');
    assert.ok(row.billingWords && row.method && row.status, r.id);
    assert.equal(row.does === 'unavailable', r.readiness !== 'ready', r.id);
  }
}

test('100 synthetic routes: every one listed, grouped by billing first, no API row in Plans', () => {
  const view = connectView(synthetic);
  invariants(synthetic, view);
  const g = Object.fromEntries(view.groups.map((x) => [x.id, x.rows]));
  assert.deepEqual(view.groups.map((x) => x.id), ORDER, 'the table reaches every group');
  assert.deepEqual([...new Set(g.plans.map((r) => r.billing))], ['subscription']);
  assert.deepEqual([...new Set(g.perUse.map((r) => r.billing))], ['api']);
  assert.ok(g.cloud.every((r) => r.via === 'cloud') && g.server.every((r) => r.via === 'endpoint'));
  assert.ok(g.local.every((r) => r.via === 'local' || r.billing === 'local'));
  assert.ok(g.other.every((r) => r.billing === 'free' || r.billing === 'unknown' || r.billing === 'subscription'));
  const claimedDefault = synthetic.filter((r) => r.billing !== 'subscription' && declaredDefault(r) && r.group !== 'services');
  assert.ok(claimedDefault.some((r) => r.billing === 'api') && claimedDefault.some((r) => r.via === 'cloud'), 'the table tries to');
  assert.ok(g.services.length && g.services.every((r) => !r.offered));
});

test('Plans snapshot: every billing claims a default offer, only plans land in Plans', () => {
  const claim = BILLINGS.flatMap((billing) => (['code', 'key', 'cloud', 'local', 'endpoint'] as const).map((via): ConnectRoute =>
    ({ id: `${billing}:${via}`, provider: billing, via, billing, offer: 'default', readiness: 'ready' })));
  const view = connectView(claim);
  assert.deepEqual(Object.fromEntries(view.groups.map((g) => [g.id, g.rows.map((r) => r.id)])), {
    plans: ['subscription:code', 'subscription:key'],
    perUse: ['api:code', 'api:key'],
    local: ['subscription:local', 'api:local', 'local:code', 'local:key', 'local:local', 'free:local', 'unknown:local'],
    server: ['subscription:endpoint', 'api:endpoint', 'local:endpoint', 'free:endpoint', 'unknown:endpoint'],
    cloud: ['subscription:cloud', 'api:cloud', 'local:cloud', 'free:cloud', 'unknown:cloud'],
    other: ['free:code', 'free:key', 'unknown:code', 'unknown:key'],
  });
  assert.deepEqual(rows(view).filter((r) => r.offered).map((r) => r.billing), ['subscription', 'subscription']);
});

test('every readiness has its own plain words, and every word passes the plain-words rule', () => {
  const status = READINESS.map((readiness) => rows(connectView([{ ...synthetic[1], readiness }]))[0].status);
  assert.equal(new Set(status).size, READINESS.length);
  for (const [k, s] of Object.entries(WORDS)) assert.doesNotMatch(s.replace(/\{\w+\}/g, 'X'), PLAIN, k);
  for (const v of VIAS) assert.ok(WORDS[`via.${v}` as keyof typeof WORDS], v);
  for (const b of BILLINGS) assert.ok(WORDS[`billing.${b}` as keyof typeof WORDS], b);
});

test('billing words are honest per billing, and a server or local row says so whatever its billing', () => {
  const words = (r: Partial<ConnectRoute>) => rows(connectView([{ ...synthetic[1], name: 'Acme Pro', company: 'Acme', ...r }]))[0].billingWords;
  assert.equal(rows(connectView([{ ...synthetic[1], billing: 'api', company: 'A$&B' }]))[0].billingWords, 'Charged per use to your A$&B account');
  assert.equal(words({ billing: 'subscription', via: 'code' }), 'Uses your Acme Pro plan');
  assert.equal(words({ billing: 'api', via: 'key' }), 'Charged per use to your Acme account');
  assert.equal(words({ billing: 'unknown', via: 'cli' }), 'Billing set by Acme');
  assert.equal(words({ billing: 'free', via: 'key' }), 'Free tier from Acme');
  assert.equal(words({ billing: 'unknown', via: 'endpoint' }), 'Your own server');
  assert.equal(words({ billing: 'local', via: 'local' }), 'Runs on this computer');
});

test('fixture discovery: the view offers exactly the fixture plans, lists every route, and keeps each one valid', () => {
  for (const c of fixture.discovery) {
    const routes = fixture.routes.map((r) => routeReadiness(r, c.host));
    const view = connectView(routes);
    invariants(routes, view);
    assert.deepEqual(rows(view).filter((r) => r.offered).map((r) => r.id).sort(), [...c.offered].sort(), c.name);
  }
});

for (const platform of ['node', 'browser', 'rn'] as const) test(`the kits' pinned tables on ${platform}: every row listed, plans alone offered`, () => {
  const routes: ConnectRoute[] = [...accountRoutes({ platform }), ...openclawRoutes({ platform })];
  const view = connectView(routes);
  invariants(routes, view);
  const plans = view.groups.find((g) => g.id === 'plans')!.rows;
  assert.ok(plans.length && plans.every((r) => r.billing === 'subscription'));
  assert.ok(rows(view).some((r) => r.group === 'perUse') && rows(view).some((r) => r.group === 'services'));
});

test('no credential reaches the view, whatever extra fields a route carries', () => {
  const canary = 'sk-canary-1f2e';
  const route = { ...synthetic[4], via: 'key', billing: 'api', readiness: 'ready', key: canary, token: canary, why: `bad ${canary}`, label: canary } as ConnectRoute;
  let step: ConnectStep = connectStep({ at: 'list' }, { type: 'pick', key: rows(connectView([route]))[0].key });
  for (const a of [{ type: 'submit' }, { type: 'result', result: 'invalid' }] as const) {
    step = connectStep(step, a);
    assert.ok(!JSON.stringify([step, connectView([route], step)]).includes(canary));
  }
});

test('steps: a key route opens the key card with words for its billing; a sign-in route hands its row to useSignIn', async () => {
  const plan = { ...synthetic[0], id: 'a:plan_key', via: 'plan_key', billing: 'subscription', offer: 'default', readiness: 'ready', group: undefined } as ConnectRoute;
  const perUse = { ...plan, id: 'a:key', via: 'key', billing: 'api', offer: 'explicit' } as ConnectRoute;
  const code = { ...plan, id: 'a:code', via: 'code' } as ConnectRoute;
  const local = { ...plan, id: 'a:local', via: 'local', billing: 'local', offer: 'explicit' } as ConnectRoute;
  const down = { ...code, id: 'a:browser', via: 'browser', readiness: 'needs_host' } as ConnectRoute;
  const all = [plan, perUse, code, local, down];
  const keyOf = (r: ConnectRoute) => `accounts/${r.id}`;
  const pick = (r: ConnectRoute) => connectStep({ at: 'list' }, { type: 'pick', key: keyOf(r) });

  const card = connectView(all, pick(plan)).chosen!;
  assert.equal(card.row.does, 'key');
  assert.deepEqual(card.key, { state: 'entry', label: WORDS['key.label.plan'], message: WORDS['key.entry'], busy: false, editable: true });
  assert.equal(connectView(all, pick(perUse)).chosen!.key!.label, WORDS['key.label.perUse']);
  let s = connectStep(pick(perUse), { type: 'submit' });
  assert.equal(connectView(all, s).chosen!.key!.busy, true);
  s = connectStep(s, { type: 'result', result: 'ok' });
  assert.equal(connectView(all, s).chosen!.key!.message, WORDS['key.ok']);
  assert.deepEqual(connectStep(s, { type: 'back' }), { at: 'list' });
  assert.deepEqual(connectStep({ at: 'list' }, { type: 'submit' }), { at: 'list' }, 'key actions do nothing on the list');

  assert.equal(connectView(all, pick(local)).chosen!.row.does, 'setup');
  const unavailable = connectView(all, pick(down)).chosen!.row;
  assert.deepEqual([unavailable.does, unavailable.status], ['unavailable', WORDS['ready.needs_host']]);
  assert.equal(signInFor(connectView(all, pick(down)), { read: async () => null, cancel: async () => {} }), undefined);
  assert.equal(connectView(all, { at: 'route', key: 'gone/x', entry: 'entry' }).chosen, undefined);

  const seen: string[] = [];
  const o = signInFor(connectView(all, pick(code)), {
    read: async (r) => { seen.push(`read ${r.id}`); return null; },
    start: async (r, body) => { seen.push(`start ${r.id} ${JSON.stringify(body)}`); },
    cancel: async (r) => { seen.push(`cancel ${r.id}`); }, ms: 5,
  })!;
  await o.read(); await o.start!({ via: 'code' }); await o.cancel();
  assert.deepEqual(seen, ['read a:code', 'start a:code {"via":"code"}', 'cancel a:code']);
  assert.equal(o.ms, 5);
});

test('useConnect holds the step and hands useSignIn the chosen row', async () => {
  const probe = `
import { useConnect } from 'useConnect-src';
import { renderHook } from 'react';
export function scenario(routes) {
  const hook = renderHook(() => useConnect({ routes, read: async () => null, cancel: async () => {} }));
  try {
    const out = [hook.result().groups.map((g) => g.id), hook.result().signIn];
    hook.result().pick('accounts/' + routes[0].id);
    out.push(hook.result().chosen.row.id, typeof hook.result().signIn.read);
    hook.result().back();
    out.push(hook.result().chosen, hook.result().step);
    return out;
  } finally { hook.unmount(); }
}`;
  const out = await build({
    stdin: { contents: probe, resolveDir: new URL('.', import.meta.url).pathname, loader: 'ts' }, bundle: true,
    alias: { 'useConnect-src': new URL('../src/useConnect.ts', import.meta.url).pathname, react: new URL('./react-stub.ts', import.meta.url).pathname },
    format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles![0].text).toString('base64')}`);
  const code = { ...synthetic[0], id: 'a:code', via: 'code', billing: 'subscription', offer: 'default', readiness: 'ready', group: undefined, upstream: { surface: 'accounts' } };
  assert.deepEqual(mod.scenario([code]), [['plans'], undefined, 'a:code', 'function', undefined, { at: 'list' }]);
});
