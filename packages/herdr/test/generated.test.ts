// H2 acceptance (docs/runtime-kits.md 11.3): regeneration from the snapshot equals the committed
// output, every method muxr calls (3.2) is present, and the protocol constant matches the snapshot.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generate, MUXR_METHODS } from '../scripts/gen-types.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { HerdrKit } from '../src/index.ts';
import type { HerdrMethod, HerdrParams, HerdrResult } from '../src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');
const snapshot = JSON.parse(readFileSync(path.join(pkg, 'schema', 'herdr-api-0.9.1.json'), 'utf8')) as Record<string, unknown>;
const methodsTs = readFileSync(path.join(pkg, 'src', 'generated', 'methods.ts'), 'utf8');
const eventsTs = readFileSync(path.join(pkg, 'src', 'generated', 'events.ts'), 'utf8');
const report = JSON.parse(readFileSync(path.join(pkg, 'src', 'generated', 'report.json'), 'utf8')) as {
  herdr: string; protocol: number; schemaVersion: number; methods: number; events: number;
  missing: string[]; unmatched: { method: string; why: string }[];
};

// Mirrors the frozen 6.2 `call` signature. The body never runs — this file is verified by
// `npm run check`; the @ts-expect-error lines fail the typecheck if the table stops refusing.
const checkedCall = async <M extends HerdrMethod>(_method: M, _params: HerdrParams<M>): Promise<HerdrResult<M>> =>
  ({}) as never;

test('regeneration from the committed snapshot is byte-identical', async () => {
  const fresh = await generate(snapshot as never);
  assert.equal(fresh.methodsTs, methodsTs);
  assert.equal(fresh.eventsTs, eventsTs);
  assert.equal(fresh.reportJson, JSON.stringify(report, null, 2) + '\n');
});

test('the report matches the snapshot and the kit constant', () => {
  assert.equal(report.herdr, '0.9.1');
  assert.equal(report.protocol, 22);
  assert.equal(snapshot.protocol, report.protocol);
  assert.equal(report.schemaVersion, snapshot.schema_version);
  assert.equal(HERDR_PROTOCOL, report.protocol);
  assert.equal(report.methods, 103);
  assert.equal(report.events, 27);
  assert.deepEqual(report.missing, []);
});

test('every method muxr calls is in the generated table (3.2)', () => {
  for (const method of MUXR_METHODS) {
    assert.match(methodsTs, new RegExp(`^  '${method.replace(/\./g, '\\.')}'\\:`, 'm'), method);
  }
});

test('unmatched methods are still present as table rows', () => {
  for (const u of report.unmatched) {
    assert.ok(!report.missing.includes(u.method), u.method);
    assert.match(methodsTs, new RegExp(`^  '${u.method.replace(/\./g, '\\.')}'\\: \\{ params: \\w+; result: unknown \\};`, 'm'), u.method);
    assert.ok(typeof u.why === 'string' && u.why.length > 0);
  }
});

test('filtered kinds carry their filter fields in HerdrSubscription', () => {
  assert.match(eventsTs, /'pane\.agent_status_changed': PaneAgentStatusChangedFilter/);
  assert.match(eventsTs, /'pane\.output_matched': PaneOutputMatchedFilter/);
  assert.match(eventsTs, /'pane\.scroll_changed': PaneScrollChangedFilter/);
  assert.match(eventsTs, /interface PaneAgentStatusChangedFilter \{[\s\S]*?pane_id: string;/);
});

test('type-level: params are checked and unknown methods refused (6.2)', async () => {
  // Compiles only when 'pane.read' params match the snapshot's PaneReadParams.
  const read = (await checkedCall('pane.read', { pane_id: 'w1:p1', source: 'visible' })) as {
    read?: { text?: string };
  };
  void read.read?.text;
  // A receipt-shaped prompt call compiles too.
  await checkedCall('agent.prompt', { target: 'w1:p2', text: 'hi' });
  // @ts-expect-error methods outside the pinned snapshot are refused at compile time
  await checkedCall('no.such_method', {});
  // @ts-expect-error params that do not match the snapshot's shape are refused
  await checkedCall('pane.read', { bogus: true });
});

test('the kit still constructs against the frozen surface (6.2)', () => {
  const k = new HerdrKit({ mode: 'adopt', bin: '/usr/local/bin/herdr', socketPath: '/tmp/herdr.sock' });
  assert.deepEqual(k.state, { phase: 'stopped' });
});
