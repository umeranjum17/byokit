import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import { socketTransport } from '../src/socket.ts';

const wait = async (ok: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) assert.fail('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

test('requests have matched replies and errors; invalid subscription is not retried', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('socket') });
  const transport = socketTransport(fake.socketPath);
  try {
    const [a, b] = await Promise.all([transport.call('ping', {}), transport.call('session.snapshot', {})]);
    assert.equal((a as { protocol: number }).protocol, 22);
    assert.ok((b as { snapshot: object }).snapshot);
    await assert.rejects(transport.call('does.not.exist', {}), { code: 'unknown_method' });
    const errors: string[] = [];
    const stop = transport.subscribe([{ type: 'pane.agent_status_changed' }], () => {}, (code) => errors.push(code));
    await wait(() => errors.length === 1);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(errors, ['invalid_subscription']);
    stop();
  } finally { transport.close(); await fake.stop(); }
});

test('filtered pane status stays on its own socket', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('status') });
  const transport = socketTransport(fake.socketPath);
  try {
    const events: string[] = [];
    const stop = transport.subscribe([{ type: 'pane.agent_status_changed', pane_id: 'w1:p2' }],
      (event) => events.push(String(event.agent_status)), () => assert.fail('subscription rejected'));
    await (stop as typeof stop & { ready: Promise<void> }).ready;
    fake.setStatus('w1:p2', 'blocked');
    await wait(() => events.includes('blocked'));
    stop();
  } finally { transport.close(); await fake.stop(); }
});
