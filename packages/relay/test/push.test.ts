// Push, ported from muxr's push tests and checkWebPush: the endpoint allowlist, subscriptions a host adds for its
// devices, notifications to Web Push and Expo (with gone subscriptions pruned and repeats sent once), buttons that
// reach the host and come back within the time limit, and subscriptions removed when a device or host is revoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { isAllowedEndpoint, isExpoToken } from '../src/index.ts';
import { paired, sleep, startRelay, until } from './helpers.ts';

test('push endpoints must be public https push services: no internal, private or credentialed addresses', () => {
  for (const bad of [
    'https://[::ffff:c0a8:101]/push', 'https://[0:0:0:0:0:ffff:c0a8:101]/push', 'https://[::ffff:192.168.1.1]/push', // muxr's mapped-IPv6 cases
    'https://10.0.0.1/p', 'https://127.0.0.1/p', 'https://169.254.169.254/latest', 'https://[fe80::1]/p', 'https://[fd00::1]/p', 'https://[::1]/p',
    'https://0x7f.1/p', 'https://100.64.1.1/p', 'https://metadata/p', 'https://printer.local/p', 'https://svc.internal/p',
    'https://user:pw@push.example.com/p', 'ftp://push.example.com/p', 'http://push.example.com/p', 'not a url', 'https://a.com/' + 'x'.repeat(2048),
  ]) assert.equal(isAllowedEndpoint(bad), false, bad);
  for (const good of ['https://push.example.com/push', 'https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/Qx', 'https://8.8.8.8/p', 'http://127.0.0.1:9/stub']) {
    assert.equal(isAllowedEndpoint(good), true, good);
  }
  assert.equal(isExpoToken('ExponentPushToken[abc_DEF-1]'), true);
  assert.equal(isExpoToken('ExponentPushToken[../../x]'), false);
});

/** A fake push world: Web Push services and Expo answer through this `fetch`, and it records every request. */
function pushWorld() {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  const gone = new Set<string>();
  const fake = (async (url: string | URL, init: RequestInit) => {
    const u = String(url);
    const headers = init.headers as Record<string, string>;
    if (u.startsWith('https://exp.host/')) {
      const msgs = JSON.parse(String(init.body));
      sent.push({ url: u, headers, body: msgs });
      return Response.json({ data: msgs.map((m: any) => (gone.has(m.to) ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' })) });
    }
    sent.push({ url: u, headers, body: init.body });
    return new Response(null, { status: gone.has(u) ? 410 : 201 });
  }) as typeof fetch;
  return { fetch: fake, sent, gone };
}

const webSub = (endpoint: string) => ({
  web: { endpoint, keys: { p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') } },
});

test('a host notifies its devices by Web Push and Expo; gone subscriptions are pruned and a repeat is sent once', async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch, subject: 'mailto:owner@example.com' } });
  const p = await paired(r);
  const phone = p.grant.device.id;
  assert.match(p.client.vapidKey!, /^[A-Za-z0-9_-]{80,}$/, 'the relay hands its Web Push key to the host, for the browser');

  await p.client.subscribe(phone, webSub('https://push.example.com/a'));
  await p.client.subscribe(phone, webSub('https://push.example.com/b'));
  await p.client.subscribe(phone, { expo: 'ExponentPushToken[old]' });
  await p.client.subscribe(phone, { expo: 'ExponentPushToken[new]' }); // a reinstall: one Expo token per device
  await p.client.subscribe('laptop', webSub('https://push.example.com/c'));
  await assert.rejects(p.client.subscribe(phone, webSub('https://169.254.169.254/x')), /bad subscription/);
  assert.deepEqual(r.saved()!.push.map((s) => ('expo' in s ? s.expo : s.web.endpoint)), ['https://push.example.com/a', 'https://push.example.com/b', 'ExponentPushToken[new]', 'https://push.example.com/c']);

  world.gone.add('https://push.example.com/b');
  const out = await p.client.notify({ id: 'evt-1', title: 'Agent update', body: 'Needs you', to: [phone], urgency: 'high', ttl: 600 });
  assert.deepEqual(out, { sent: 2 });
  const web = world.sent.find((s) => s.url === 'https://push.example.com/a')!;
  assert.equal(web.headers.TTL, '600');
  assert.equal(web.headers.Urgency, 'high');
  assert.equal(web.headers['Content-Encoding'], 'aes128gcm', 'encrypted to the browser: the push service cannot read it');
  assert.match(web.headers.Authorization!, /^vapid t=.+, k=/);
  const expo = world.sent.find((s) => s.url.startsWith('https://exp.host/'))!;
  assert.deepEqual(expo.body, [{ to: 'ExponentPushToken[new]', title: 'Agent update', body: 'Needs you', sound: 'default', collapseId: 'evt-1', ttl: 600, priority: 'high', data: { id: 'evt-1', title: 'Agent update', body: 'Needs you' } }]);
  assert.ok(!world.sent.some((s) => s.url.endsWith('/c')), '`to` picked the phone only');
  assert.ok(!r.saved()!.push.some((s) => 'web' in s && s.web.endpoint.endsWith('/b')), 'a 410 prunes the subscription');

  const before = world.sent.length;
  assert.deepEqual(await p.client.notify({ id: 'evt-1', title: 'Agent update', body: 'Needs you' }), { sent: 0, duplicate: true });
  assert.equal(world.sent.length, before);

  world.gone.add('ExponentPushToken[new]');
  await p.client.notify({ id: 'evt-2', title: 'Agent update', body: 'Done' });
  assert.ok(!r.saved()!.push.some((s) => 'expo' in s), 'DeviceNotRegistered prunes the token');
  await assert.rejects(p.client.notify({ id: 'bad id!', title: 't', body: 'b' }), /bad notification/);
});

test("revoking a device removes its subscriptions; revoking the host removes all of the host's", async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const p = await paired(r);
  const other = await paired(r, 'Other phone');
  await p.client.subscribe(p.grant.device.id, { expo: 'ExponentPushToken[phone]' });
  await p.client.subscribe('kept', webSub('https://push.example.com/kept'));
  await other.client.subscribe(other.grant.device.id, { expo: 'ExponentPushToken[other]' });
  await p.client.revoke(p.grant.device.id);
  await until(() => p.dev.link.status === 'removed');
  assert.deepEqual(r.saved()!.push.map((s) => s.device), ['kept', other.grant.device.id]);
  await r.relay.revoke(p.host.id);
  assert.deepEqual(r.saved()!.push.map((s) => s.device), [other.grant.device.id]);
});

test('a notification button reaches the host and its answer comes back; one use, known buttons only, within the time limit (15 s by default)', async () => {
  const world = pushWorld();
  const actions: unknown[] = [];
  let slow = false;
  const r = await startRelay({ push: { fetch: world.fetch }, actionMs: 300 });
  const h = await paired(r, 'Away phone', {
    onAction: async (a) => { actions.push(a); if (slow) await sleep(1000); if (a.action === 'no') throw new Error('declined'); return { answered: a.action }; },
  });
  const phone = h.grant.device.id;
  await h.client.subscribe(phone, { expo: 'ExponentPushToken[phone]' });
  const press = (token: string, action: string) =>
    fetch(`${r.http}/relay/v1/push/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, action }) });
  const tokenOf = async (id: string) => {
    await h.client.notify({ id, title: 'Allow?', body: 'An agent asks', actions: ['yes', 'no'] });
    const data = world.sent.at(-1)!.body[0].data;
    assert.deepEqual(data.actions, ['yes', 'no']);
    return data.action as string;
  };

  const t1 = await tokenOf('ask-1');
  assert.equal((await press(t1, 'maybe')).status, 400, 'only the buttons the host offered');
  const ok = await press(t1, 'yes');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, value: { answered: 'yes' } });
  assert.deepEqual(actions, [{ device: phone, event: 'ask-1', action: 'yes' }]);
  assert.equal((await press(t1, 'yes')).status, 404, 'one use');

  const t2 = await tokenOf('ask-2');
  const no = await press(t2, 'no');
  assert.equal(no.status, 502);
  assert.deepEqual(await no.json(), { error: 'declined' });

  slow = true;
  assert.equal((await press(await tokenOf('ask-3'), 'yes')).status, 504, 'the host did not answer in time');

  const t4 = await tokenOf('ask-4');
  h.client.stop();
  await until(() => r.relay.hosts()[0]!.online === false);
  assert.equal((await press(t4, 'yes')).status, 503, 'the computer is offline; the button still works later');
  assert.equal((await press('made-up', 'yes')).status, 404);
});
