import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyPair } from '../src/index.ts';
import type { Grant } from '../src/host.ts';
import { startHost, connect, pairWithOffer, until } from './helpers.ts';

// Privacy cleanup is tied to authority, not connectivity. No browser or external site is involved.
test('R4: offline revoke invalidates access before awaited privacy cleanup; socket drop is not revoke', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const removed: { id: string; why: string }[] = [];
  const h = await startHost({ onGrantRemoved: (g, why) => { removed.push({ id: g.id, why }); return barrier; } });
  const grant = await pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Viewer' });
  const d = connect(grant);
  await until(() => d.link.status === 'online');
  d.link.stop();
  await until(() => !h.host.devices()[0]?.online);
  assert.deepEqual(removed, [], 'ordinary disconnect preserves the app lease grace');
  let settled = false;
  const revoking = h.host.revoke(grant.device.id).then(() => { settled = true; });
  await until(() => removed.length === 1);
  assert.equal(settled, false);
  assert.deepEqual(h.host.devices(), [], 'offline authority is gone before private-tab close completes');
  assert.deepEqual(removed, [{ id: grant.device.id, why: 'revoked' }]);
  release(); await revoking;
  await h.host.revoke(grant.device.id);
  assert.equal(removed.length, 1, 'already removed is not notified twice');
});

test('R4: reload role changes and expiry call cleanup for offline grants; failures never restore access', async () => {
  let rows: Grant[] = [];
  let now = Date.now();
  const removed: string[] = [];
  const h = await startHost({ now: () => now, grants: { load: () => rows, save: g => { rows = g; } },
    onGrantRemoved: (_g, why) => { removed.push(why); } });
  const key = keyPair();
  const g = await h.host.enrol({ key: key.publicKey, name: 'Offline', role: 'control', lifetime: 10000 });
  rows = rows.map(r => ({ ...r, role: 'view' }));
  await h.host.reload();
  assert.deepEqual(removed, ['changed']);
  now += 11000;
  await h.host.reload();
  assert.deepEqual(removed, ['changed', 'expired']);
  assert.equal(h.host.devices()[0]?.id, g.id);

  const failing = await startHost({ onGrantRemoved: () => { throw new Error('privacy cleanup refused'); } });
  const doomed = await failing.host.enrol({ key: key.publicKey, name: 'Offline', role: 'control' });
  await assert.rejects(failing.host.revoke(doomed.id), /privacy cleanup refused/);
  assert.deepEqual(failing.host.devices(), [], 'cleanup failure never revives a durable removal');
});
