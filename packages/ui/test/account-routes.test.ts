// D18 account routes (docs/runtime-kits.md §2.1): the shared vocabulary every kit restates structurally, checked
// against fixtures/conformance/account-routes-typescript.json. The reference rules here are the contract the kits'
// route tables and the connect view are built to; the kits' current shapes must already fit (checked by
// `npm run check`; `fits` never runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Billing as AccountsBilling } from '../../accounts/src/catalogue.ts';
import type { AccountLike, Via as AccountsVia } from '../../accounts/src/multi.ts';
import type { Route as OpenClawRoute } from '../../openclaw/src/types.ts';
import type { StartAgent } from '../../herdr/src/types.ts';

export type Billing = 'subscription' | 'api' | 'local' | 'free' | 'unknown';
export type Via = 'browser' | 'code' | 'paste' | 'key' | 'session' | 'setup_token' | 'cli' | 'plan_key' | 'cloud' | 'local' | 'endpoint';
export type Support = 'yes' | 'host' | 'no';
export type Platform = 'node' | 'browser' | 'rn';
export type Readiness = 'ready' | 'needs_binary' | 'needs_plugin' | 'needs_host' | 'needs_client' | 'unsupported_platform' | 'no_upstream_flow';
export type Route = {
  id: string; provider: string; name: string; company: string; label: string;
  via: Via; billing: Billing; billingFrom: 'source' | 'host'; offer: 'default' | 'explicit';
  platforms: Record<Platform, Support>;
  needs?: { binary?: string; plugin?: string; client?: string };
  folderVar?: string; move?: boolean;
  upstream: { surface: 'accounts' | 'openclaw' | 'herdr'; id: string; method?: string; revision: string; flow: 'present' | 'absent' };
  aliases?: string[];
};
export type Host = { platform: Platform; hostSide?: boolean; binaries?: string[]; plugins?: string[]; clients?: string[] };

type Fixture = {
  vocabulary: Record<'via' | 'billing' | 'billingFrom' | 'offer' | 'support' | 'platform' | 'surface' | 'flow' | 'readiness' | 'excluded', string[]>;
  routes: Route[];
  invalid: { name: string; code: string; base: string; set: Record<string, unknown> }[];
  readiness: { name: string; route: string; host: Host; expected: Readiness }[];
  discovery: { name: string; host: Host; listed: 'all'; offered: string[] }[];
  endpointBilling: { name: string; input: { baseUrl: string; billing?: string }; expected: { code: string } | { billing: Billing; offer: string; auto: boolean } }[];
};
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/account-routes-typescript.json', import.meta.url), 'utf8')) as Fixture;
const v = fixture.vocabulary;
const PER_USE = /per use/i;
const SECRET = /^(key|apiKey|token|secret|access|refresh|password|credential)s?$/i;

/** First broken rule, or undefined for a valid route. */
function check(r: Record<string, unknown>): string | undefined {
  const route = r as Route;
  if (Object.keys(r).some((k) => SECRET.test(k))) return 'secret_in_route';
  if (v.excluded.includes(route.via)) return 'excluded_mechanism';
  if (!v.via.includes(route.via)) return 'unknown_via';
  if (!v.billing.includes(route.billing)) return 'unknown_billing';
  const [provider, via] = String(route.id).split(':');
  if (provider !== route.provider || via !== route.via) return 'id_mismatch';
  if (!route.platforms || !v.platform.every((p) => v.support.includes(route.platforms[p as Platform]))) return 'platforms_incomplete';
  const up = route.upstream;
  if (!up || !v.surface.includes(up.surface) || !up.id || !up.revision || !v.flow.includes(up.flow)) return 'upstream_missing';
  if (!v.billingFrom.includes(route.billingFrom)) return 'billing_inferred';
  if (route.via === 'endpoint' && route.billingFrom !== 'host') return 'endpoint_billing_not_explicit';
  if (route.offer === 'default' && route.billing !== 'subscription') return 'default_not_subscription';
  if (route.offer !== 'default' && route.billing === 'subscription') return 'subscription_not_default';
  if (PER_USE.test(route.label) !== (route.billing === 'api')) return 'label_billing_mismatch';
  if ('readiness' in r) return 'readiness_in_route';
  if ('proven' in r || 'live' in r || 'qualified' in r) return 'qualification_in_route';
  if ('fallback' in r) return 'fallback_route';
  if (route.move && !route.folderVar) return 'move_without_folder';
  return undefined;
}

/** Route and host facts only: the credential store is never consulted. */
function readiness(route: Route, host: Host): Readiness {
  if (route.upstream.flow === 'absent') return 'no_upstream_flow';
  const support = route.platforms[host.platform];
  if (support === 'no') return 'unsupported_platform';
  if (support === 'host' && !host.hostSide) return 'needs_host';
  if (route.needs?.binary && !host.binaries?.includes(route.needs.binary)) return 'needs_binary';
  if (route.needs?.plugin && !host.plugins?.includes(route.needs.plugin)) return 'needs_plugin';
  if (route.needs?.client && !host.clients?.includes(route.needs.client)) return 'needs_client';
  return 'ready';
}

const discover = (routes: Route[], host: Host) => routes.map((r) => ({ ...r, readiness: readiness(r, host) }));
const offered = (routes: Route[], host: Host) => discover(routes, host).filter((r) => r.offer === 'default' && r.readiness === 'ready').map((r) => r.id);

/** A custom endpoint's billing is what the person chose; the address never decides it. */
function endpointBilling(input: { baseUrl: string; billing?: string }) {
  if (input.billing === undefined) return { code: 'billing_required' };
  if (!v.billing.includes(input.billing)) return { code: 'unknown_billing' };
  const billing = input.billing as Billing;
  return { billing, offer: billing === 'subscription' ? 'default' : 'explicit', auto: billing === 'subscription' };
}

const byId = new Map(fixture.routes.map((r) => [r.id, r]));

test('every example route satisfies D18 and ids are unique', () => {
  assert.equal(byId.size, fixture.routes.length);
  for (const r of fixture.routes) assert.equal(check(r), undefined, r.id);
});

test('examples cover every via, billing, surface and readiness word', () => {
  assert.deepEqual([...new Set(fixture.routes.map((r) => r.billing))].sort(), [...v.billing].sort());
  assert.deepEqual([...new Set(fixture.routes.map((r) => r.upstream.surface))].sort(), [...v.surface].sort());
  assert.deepEqual([...new Set(fixture.readiness.map((c) => c.expected))].sort(), [...v.readiness].sort());
  const vias = new Set(fixture.routes.map((r) => r.via));
  assert.deepEqual(v.via.filter((x) => !vias.has(x as Via)), ['session'], 'every via but the legacy session has an example');
  assert.ok(v.excluded.every((x) => !v.via.includes(x)), 'no excluded mechanism is a via');
});

for (const c of fixture.invalid) test(`invalid route: ${c.name}`, () => {
  const base = byId.get(c.base);
  assert.ok(base, c.base);
  assert.equal(check({ ...base, ...c.set }), c.code);
});

for (const c of fixture.readiness) test(`readiness: ${c.name}`, () => {
  const route = byId.get(c.route);
  assert.ok(route, c.route);
  assert.equal(readiness(route, c.host), c.expected);
});

for (const c of fixture.discovery) test(`discovery: ${c.name}`, () => {
  const listed = discover(fixture.routes, c.host);
  assert.deepEqual(listed.map((r) => r.id), fixture.routes.map((r) => r.id), 'unavailable routes are listed too');
  assert.deepEqual(offered(fixture.routes, c.host), c.offered);
  for (const id of c.offered) assert.equal(byId.get(id)!.billing, 'subscription');
});

for (const c of fixture.endpointBilling) test(`endpoint billing: ${c.name}`, () => {
  assert.deepEqual(endpointBilling(c.input), c.expected);
});

export const fits = (
  accountsVia: AccountsVia, accountsBilling: AccountsBilling, auto: AccountLike['billing'],
  oc: OpenClawRoute, herdrKind: StartAgent['kind'],
) => {
  const via: Via = accountsVia;
  const billing: Billing[] = [accountsBilling, auto, oc.billing];
  const ocVia: Via = oc.via;
  const upstream: Route['upstream'][] = [
    { surface: 'openclaw', id: oc.choice, revision: oc.revision, flow: 'present' },
    { surface: 'herdr', id: herdrKind, revision: 'herdr@0.9.1', flow: 'present' },
  ];
  return { via, billing, ocVia, upstream };
};
