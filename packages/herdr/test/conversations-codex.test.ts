import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/index.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import { exportStore } from '../src/conversations.ts';

test('export/import Codex rollout JSONL while retaining its native conversation id and earlier turn', async () => {
  const root = realpathSync(scratchDir('codex-conversation')), a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  const id = '72345678-1234-1234-1234-123456789abc';
  const path = `sessions/2026/10/25/rollout-2026-10-25T00-00-00-000Z-${id}.jsonl`;
  mkdirSync(join(a, path, '..'), { recursive: true });
  const body = `${JSON.stringify({ timestamp: '2026-10-25T00:00:00Z', type: 'session_meta', payload: { id, cwd: '/fixture' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier Codex turn' }] } })}\n`;
  writeFileSync(join(a, path), body);
  const fake = await startFakeHerdr({ dir: join(root, 'fake'), world: { kinds: ['codex'] } });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: fake.socketPath });
  try {
    await kit.start();
    const ref = await kit.startAgent({ kind: 'codex', cwd: a, place: { pane: 'w1:p1' }, args: ['resume', id], installProbe: { path: [] },
      env: { env: { HOME: a, CODEX_HOME: a }, unset: [] } });
    fake.world.agents.find((x) => x.pane_id === ref.paneId)!.agent_session = { source: 'fixture', agent: 'codex', kind: 'id', value: id };
    const bundle = join(root, 'bundle'), first = await kit.exportConversation(ref, { to: bundle });
    assert.equal(first.ok, true, JSON.stringify(first)); if (!first.ok) return;
    assert.equal(first.conversation, id);
    const options = { bundle, accountFolder: b, kind: 'codex', conversation: id };
    assert.deepEqual(await kit.importConversation(options), first);
    const restored = readFileSync(join(b, path), 'utf8');
    assert.equal(restored, body); assert.match(restored, /Earlier Codex turn/);
    assert.deepEqual(await exportStore('codex', b, id, { to: join(root, 'bundle-again') }), first);
  } finally { await kit.stop(); await fake.stop(); }
});
