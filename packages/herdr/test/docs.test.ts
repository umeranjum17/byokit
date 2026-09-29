// K10 acceptance: docs drift stays fixed. README pins the v0.9.1 snapshot (no protocol
// placeholder), agents.ts agrees with muxr that `pane.split` takes `target_pane_id` (and the
// kit sends exactly that), and the fake bin's `api schema` prints the pinned snapshot itself —
// all against the kit fake, never a real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scratchDir } from '../../test-support.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import type { HerdrTransport } from '../src/types.ts';

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');
const readme = readFileSync(path.join(pkg, 'README.md'), 'utf8');
const agentsSrc = readFileSync(path.join(pkg, 'src', 'agents.ts'), 'utf8');
const binSrc = readFileSync(path.join(pkg, 'src', 'testing', 'fake-herdr', 'bin.ts'), 'utf8');

test('README pins the v0.9.1 snapshot instead of a protocol placeholder', () => {
  assert.ok(!readme.includes('placeholder'), 'no placeholder language remains');
  assert.ok(!readme.includes('until the v0.9.1 schema snapshot is captured'),
    'the H2-capture placeholder sentence is gone');
  assert.ok(readme.includes('schema/herdr-api-0.9.1.json'), 'names the pinned snapshot');
  assert.ok(readme.includes(String(HERDR_PROTOCOL)), 'names the pinned protocol');
});

test('agents.ts agrees muxr sends target_pane_id to pane.split', () => {
  assert.ok(!agentsSrc.includes('muxr sends `pane_id`'),
    'the false pane_id claim is gone');
  assert.ok(agentsSrc.includes('`target_pane_id` (muxr agrees)'),
    'records that muxr and the schema agree on target_pane_id');
});

test('startAgent split placement sends target_pane_id, never pane_id', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const transport: HerdrTransport = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'ping') return { protocol: HERDR_PROTOCOL };
      if (method === 'session.snapshot') {
        return { snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'x' }],
          tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
          panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
          agents: [],
        } };
      }
      if (method === 'pane.split') return { pane: { pane_id: 'w1:p9' } };
      return { agent: {} };
    },
    subscribe: () => () => {},
    close: () => {},
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: '/not/used', transport });
  try {
    await kit.start();
    const ref = await kit.startAgent({ kind: 'pi', cwd: '/repo', place: { split: 'w1:p1', direction: 'right' } });
    assert.equal(ref.paneId, 'w1:p9');
    const split = calls.find((c) => c.method === 'pane.split');
    assert.ok(split !== undefined, 'a pane.split call was made');
    assert.equal(split.params.target_pane_id, 'w1:p1', 'the split names target_pane_id');
    assert.ok(!('pane_id' in split.params), 'no legacy pane_id rides the split');
  } finally {
    await kit.stop();
  }
});

test('fake bin api schema prints the pinned snapshot with no placeholder', async () => {
  assert.ok(!binSrc.includes('placeholder'), 'no placeholder language remains in bin.ts');
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k10-docs') });
  try {
    const out = await run(fake.bin, ['api', 'schema', '--json']);
    const parsed = JSON.parse(out.stdout) as { protocol?: number; schema_version?: number;
      schemas?: { request?: { $defs?: Record<string, unknown> } } };
    assert.equal(parsed.protocol, HERDR_PROTOCOL, 'the snapshot carries the pinned protocol');
    assert.equal(parsed.schema_version, 1);
    assert.ok(parsed.schemas?.request?.$defs?.AgentStartParams, 'the request schemas ride along');
    const snapshot = readFileSync(path.join(pkg, 'schema', 'herdr-api-0.9.1.json'), 'utf8');
    assert.equal(out.stdout.trim(), snapshot.trim(), 'byte-identical to the pinned snapshot file');
  } finally {
    await fake.stop();
  }
});
