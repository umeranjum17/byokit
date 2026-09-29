// O2 acceptance (docs/runtime-kits.md 11.2 O2): the generated tables carry exactly 382 operator and 11 node
// methods (393 total) and 55 events, the kit's methods and approval resolvers are present, node-role names are
// excluded from GatewayMethod, and the typed pass-through compiles (checked by tsc in `npm run check`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const genDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'generated');
const methodsTs = readFileSync(join(genDir, 'methods.ts'), 'utf8');
const eventsTs = readFileSync(join(genDir, 'events.ts'), 'utf8');
const report = JSON.parse(readFileSync(join(genDir, 'report.json'), 'utf8')) as {
  engine: string;
  protocol: number;
  methods: number;
  operatorMethods: number;
  nodeMethods: number;
  events: number;
  matchedParams: number;
  matchedResults: number;
  matchedEvents: number;
  unmatched: { method?: string; event?: string; slot: string }[];
};

const ENTRY = /^  '([^']+)': \{ params: ([^;{]+); result: ([^;{]+); scope: '([^']+)'; role: '([^']+)' \};$/gm;
const operator = new Map<string, { params: string; result: string; scope: string }>();
const nodeMethods = new Map<string, { params: string; result: string; scope: string }>();
for (const [, name, params, result, scope, role] of methodsTs.matchAll(ENTRY)) {
  (role === 'node' ? nodeMethods : operator).set(name, { params: params.trim(), result: result.trim(), scope });
}
const EVENT = /^  '([^']+)': (.+);$/gm;
const events = new Map<string, string>();
for (const [, name, payload] of eventsTs.matchAll(EVENT)) events.set(name, payload.trim());

test('the pinned table has exactly 382 operator and 11 node methods (393 total) and 55 events, recorded in report.json (D6)', () => {
  assert.equal(operator.size, 382);
  assert.equal(nodeMethods.size, 11);
  assert.equal(operator.size + nodeMethods.size, 393);
  assert.equal(events.size, 55);
  assert.equal(report.engine, '2026.8.1');
  assert.equal(report.protocol, 4);
  assert.equal(report.methods, 393);
  assert.equal(report.operatorMethods, 382);
  assert.equal(report.nodeMethods, 11);
  assert.equal(report.events, 55);
});

test('node-role methods carry role node with node scope and sit outside the operator table (D6)', () => {
  assert.ok(nodeMethods.has('node.invoke.result'));
  assert.ok(nodeMethods.has('node.invoke.progress'));
  for (const [name, entry] of nodeMethods) {
    assert.equal(entry.scope, 'node', name);
    assert.ok(!operator.has(name), name);
    assert.ok(methodsTs.includes(`'${name}': { params: ${entry.params}; result: ${entry.result}; scope: 'node'; role: 'node' }`));
  }
});

test('every method the kit calls or tests is in the operator table (O2 acceptance, 5.7-5.9)', () => {
  const required = [
    'agents.list', 'agents.create', 'models.authStatus', 'models.authLogout', 'openclaw.setup.auth.start',
    'wizard.next', 'wizard.cancel', 'wizard.status', 'config.get', 'config.patch', 'agent', 'agent.wait',
    'sessions.steer', 'chat.abort', 'health', 'skills.proposals.list', 'skills.proposals.reject',
    'skills.proposals.quarantine', 'skills.curator.status', 'cron.list', 'cron.run', 'cron.runs',
    'exec.approval.resolve', 'plugin.approval.resolve', 'question.resolve', 'sessions.list',
  ];
  for (const m of required) assert.ok(operator.has(m), `missing operator method ${m}`);
});

test('the 24 aux approval and secret methods are core-list members, not extras (3.1)', () => {
  const aux = [
    'exec.approval.get', 'exec.approval.list', 'exec.approval.request', 'exec.approval.waitDecision', 'exec.approval.resolve',
    'exec.approval.grants.list', 'exec.approval.grants.revoke', 'plugin.approval.list', 'plugin.approval.request',
    'plugin.approval.waitDecision', 'plugin.approval.resolve', 'approval.get', 'approval.history', 'approval.resolve',
    'question.request', 'question.waitAnswer', 'question.resolve', 'question.get', 'question.list', 'secrets.reload',
    'secrets.resolve', 'secrets.store.list', 'secrets.store.set', 'secrets.store.delete',
  ];
  for (const m of aux) assert.ok(operator.has(m) || nodeMethods.has(m), `missing aux method ${m}`);
});

test('the approval and agent events are in the event table (O2 acceptance)', () => {
  for (const e of [
    'agent', 'exec.approval.requested', 'exec.approval.resolved', 'plugin.approval.requested', 'plugin.approval.resolved',
    'question.requested', 'question.resolved',
  ]) assert.ok(events.has(e), `missing event ${e}`);
});

test('report.json matches the tables it summarizes (5.10)', () => {
  const matchedParams = [...operator.values(), ...nodeMethods.values()].filter((e) => e.params !== 'unknown').length;
  const matchedResults = [...operator.values(), ...nodeMethods.values()].filter((e) => e.result !== 'unknown').length;
  const matchedEvents = [...events.values()].filter((p) => p !== 'unknown').length;
  assert.equal(report.matchedParams, matchedParams);
  assert.equal(report.matchedResults, matchedResults);
  assert.equal(report.matchedEvents, matchedEvents);
  assert.equal(
    report.unmatched.length,
    393 * 2 - matchedParams - matchedResults + 55 - matchedEvents,
  );
  for (const entry of report.unmatched) {
    if (entry.method) assert.ok(operator.has(entry.method) || nodeMethods.has(entry.method), entry.method);
    else assert.ok(events.has(entry.event!), entry.event);
  }
});

test('every operator scope is one of the seven operator scopes or dynamic (D6)', () => {
  const scopes = new Set([...operator.values()].map((e) => e.scope));
  for (const s of scopes) {
    assert.ok(
      s === 'dynamic' || /^operator\.(read|write|admin|approvals|questions|pairing|talk)$/.test(s),
      `unexpected scope ${s}`,
    );
  }
});

// The compile-time half: tsc (npm run check) proves the typed calls; node --test never runs them.
import type { GatewayMethod, GatewayParams, GatewayResult } from '../src/generated/methods.ts';

declare function call<M extends GatewayMethod>(method: M, params: GatewayParams<M>): Promise<GatewayResult<M>>;

function typeChecks(): void {
  void (async () => {
    await call('models.authStatus', { agentId: 'm1' });
    // Gap 6: anyOf branches keep their full property set, so cron.run accepts the schema's mode
    // and expectedProcessInstanceId beside either id or jobId (params.ts re-emits the union locally).
    await call('cron.run', { id: 'x', mode: 'force' });
    await call('cron.run', { jobId: 'j', mode: 'due', expectedProcessInstanceId: 'p' });
    // @ts-expect-error mode stays a closed literal union, not string.
    await call('cron.run', { id: 'x', mode: 'sometimes' });
    // @ts-expect-error node-role methods are listed in the table but never part of GatewayMethod (D6).
    await call('node.invoke.result', {});
  })();
}

test('the compile-time pass-through checks are present for tsc to verify', () => {
  assert.equal(typeof typeChecks, 'function');
});
