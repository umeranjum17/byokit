import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/index.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import { exportStore } from '../src/conversations.ts';

test('export/import OpenCode session, message and parts without losing earlier turns', async () => {
  const root = realpathSync(scratchDir('opencode-conversation')), a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  const id = 'ses_01j8y0z7v9m2k4p6q8r0s1t3wx', message = 'msg_01j8y0z7v9m2k4p6q8r0s1t3wx';
  const session = `storage/session/project/${id}.json`, msg = `storage/message/${id}/${message}.json`, part = `storage/part/${message}/part_01.json`;
  for (const path of [session, msg, part]) mkdirSync(join(a, path, '..'), { recursive: true });
  const sessionBody = JSON.stringify({ id, projectID: 'project', directory: '/fixture', title: 'Fixture conversation', time: { created: 1, updated: 2 } });
  const messageBody = JSON.stringify({ id: message, sessionID: id, role: 'user', time: { created: 1 } });
  const partBody = JSON.stringify({ id: 'part_01', messageID: message, type: 'text', text: 'Earlier OpenCode turn' });
  writeFileSync(join(a, session), sessionBody); writeFileSync(join(a, msg), messageBody); writeFileSync(join(a, part), partBody);
  const fake = await startFakeHerdr({ dir: join(root, 'fake'), world: { kinds: ['opencode'] } });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: fake.socketPath });
  try {
    await kit.start();
    const ref = await kit.startAgent({ kind: 'opencode', cwd: a, place: { pane: 'w1:p1' }, args: ['--session', id], installProbe: { path: [] },
      env: { env: { HOME: a, OPENCODE_DATA_DIR: a }, unset: [] } });
    fake.world.agents.find((x) => x.pane_id === ref.paneId)!.agent_session = { source: 'fixture', agent: 'opencode', kind: 'id', value: id };
    const bundle = join(root, 'bundle'), first = await kit.exportConversation(ref, { to: bundle });
    assert.equal(first.ok, true, JSON.stringify(first)); if (!first.ok) return;
    assert.equal(first.conversation, id); assert.equal(first.files, 3);
    const options = { bundle, accountFolder: b, kind: 'opencode', conversation: id };
    assert.deepEqual(await kit.importConversation(options), first);
    assert.equal(readFileSync(join(b, session), 'utf8'), sessionBody);
    assert.equal(readFileSync(join(b, msg), 'utf8'), messageBody);
    const earlierTurn = readFileSync(join(b, part), 'utf8');
    assert.equal(earlierTurn, partBody); assert.match(earlierTurn, /Earlier OpenCode turn/);
    assert.deepEqual(await exportStore('opencode', b, id, { to: join(root, 'bundle-again') }), first);
  } finally { await kit.stop(); await fake.stop(); }
});
