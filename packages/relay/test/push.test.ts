// Push, ported from muxr's push tests and checkWebPush: the endpoint allowlist, subscriptions a host adds for its
// devices, notifications to Web Push and Expo (with gone subscriptions pruned and repeats sent once), buttons that
// reach the host and come back within the time limit, and subscriptions removed when a device or host is revoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { isAllowedEndpoint, isExpoToken } from '../src/index.ts';
import { hostClient, paired, sleep, startHost, startRelay, until } from './helpers.ts';

test('push endpoints must be public https push services: no internal, private or credentialed addresses', () => {
  for (const bad of [
    'https://[::ffff:c0a8:101]/push', 'https://[0:0:0:0:0:ffff:c0a8:101]/push', 'https://[::ffff:192.168.1.1]/push', // muxr's mapped-IPv6 cases
    'https://10.0.0.1/p', 'https://127.0.0.1/p', 'https://169.254.169.254/latest', 'https://[fe80::1]/p', 'https://[fd00::1]/p', 'https://[::1]/p',
    'https://0x7f.1/p', 'https://100.64.1.1/p', 'https://metadata/p', 'https://printer.local/p', 'https://svc.internal/p',
    'https://user:pw@fcm.googleapis.com/p', 'https://push.example.com/p', 'https://push.apple.com/p', 'https://fakepush.apple.com.evil.test/p',
    'https://fcm.googleapis.com:8443/p', 'ftp://fcm.googleapis.com/p', 'http://fcm.googleapis.com/p', 'http://127.0.0.1:9/stub', 'http://[::1]/stub', 'not a url', 'https://a.com/' + 'x'.repeat(2048),
  ]) assert.equal(isAllowedEndpoint(bad), false, bad);
  for (const good of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/Qx', 'https://updates.push.services.mozilla.com/p', 'https://x.notify.windows.com/p']) {
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

  await p.client.subscribe(phone, webSub('https://fcm.googleapis.com/a'));
  await p.client.subscribe(phone, webSub('https://fcm.googleapis.com/b'));
  await p.client.subscribe(phone, { expo: 'ExponentPushToken[old]' });
  await p.client.subscribe(phone, { expo: 'ExponentPushToken[new]' }); // a reinstall: one Expo token per device
  await p.client.subscribe('laptop', webSub('https://fcm.googleapis.com/c'));
  await assert.rejects(p.client.subscribe(phone, webSub('https://169.254.169.254/x')), /bad subscription/);
  await assert.rejects(p.client.subscribe(phone, webSub('https://push.example.com/x')), /bad subscription/);
  assert.deepEqual(r.saved()!.push.map((s) => ('expo' in s ? s.expo : s.web.endpoint)), ['https://fcm.googleapis.com/a', 'https://fcm.googleapis.com/b', 'ExponentPushToken[new]', 'https://fcm.googleapis.com/c']);

  world.gone.add('https://fcm.googleapis.com/b');
  const out = await p.client.notify({ id: 'evt-1', title: 'Agent update', body: 'Needs you', to: [phone], urgency: 'high', ttl: 600 }, { includeContent: true });
  assert.deepEqual(out, { sent: 2 });
  const web = world.sent.find((s) => s.url === 'https://fcm.googleapis.com/a')!;
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

test('notifications omit body and data by default and forward them only by explicit opt-in', async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const p = await paired(r);
  await p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]' });
  const input = { id: 'generic', title: 'Agent update', body: 'Private message', data: { secret: 'private data' } };
  await p.client.notify(input);
  const frames = () => p.wire.map((s) => { try { return JSON.parse(s); } catch { return {}; } }).filter((m) => m.t === 'push.notify');
  assert.deepEqual(frames().at(-1)!.n, { id: 'generic', title: 'Agent update' });
  assert.deepEqual(world.sent.at(-1)!.body[0].data, { id: 'generic', title: 'Agent update' });
  assert.equal('body' in world.sent.at(-1)!.body[0], false);
  assert.equal(input.body, 'Private message');
  await p.client.notify({ ...input, id: 'included' }, { includeContent: true });
  assert.deepEqual(frames().at(-1)!.n, { ...input, id: 'included' });
  assert.deepEqual(world.sent.at(-1)!.body[0].data, { ...input, id: 'included' });
  assert.equal(world.sent.at(-1)!.body[0].body, input.body);
});

test("revoking a device removes its subscriptions; revoking the host removes all of the host's", async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const p = await paired(r);
  const other = await paired(r, 'Other phone');
  await p.client.subscribe(p.grant.device.id, { expo: 'ExponentPushToken[phone]' });
  await p.client.subscribe('kept', webSub('https://fcm.googleapis.com/kept'));
  await other.client.subscribe(other.grant.device.id, { expo: 'ExponentPushToken[other]' });
  await p.client.revoke(p.grant.device.id);
  await until(() => p.dev.link.status === 'removed');
  assert.deepEqual(r.saved()!.push.map((s) => s.device), ['kept', other.grant.device.id]);
  await r.relay.revoke(p.host.id);
  assert.deepEqual(r.saved()!.push.map((s) => s.device), [other.grant.device.id]);
});

test('failed subscription writes leave both memory and storage unchanged', async () => {
  let saved: any;
  let fail = false;
  const r = await startRelay({ store: {
    load: () => saved,
    save: (s) => { if (fail) { fail = false; throw new Error('disk failed'); } saved = s; },
  } });
  const p = await paired(r);
  const sub = { expo: 'ExponentPushToken[phone]' };
  fail = true;
  await assert.rejects(p.client.subscribe('phone', sub), /disk failed/);
  assert.deepEqual(saved.push, []);
  await p.client.subscribe('phone', sub);
  fail = true;
  await assert.rejects(p.client.unsubscribe('phone'), /disk failed/);
  assert.deepEqual(saved.push.map((s: { device: string }) => s.device), ['phone']);
  await p.client.unsubscribe('phone');
  assert.deepEqual(saved.push, []);
});

test('targeted unsubscribe retains action tokens while another address remains', async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const p = await paired(r, 'Phone', { onAction: (a) => a.event });
  const device = p.grant.device.id;
  const first = webSub('https://fcm.googleapis.com/first');
  const second = webSub('https://fcm.googleapis.com/second');
  const expo = { expo: 'ExponentPushToken[phone]' };
  await p.client.subscribe(device, first);
  await p.client.subscribe(device, second);
  await p.client.subscribe(device, expo);
  await p.client.notify({ id: 'keep-action', title: 'Approve', body: 'Request', actions: ['yes'] });
  const token = world.sent.find((s) => s.url.startsWith('https://exp.host/'))!.body[0].data.action;
  await p.client.unsubscribe(device, expo);
  await p.client.unsubscribe(device, first);
  assert.deepEqual(r.saved()!.push.map((s) => 'web' in s && s.web.endpoint), [second.web.endpoint]);
  const press = (value: string) => fetch(`${r.http}/relay/v1/push/action`, { method: 'POST', body: JSON.stringify({ token: value, action: 'yes' }) });
  assert.deepEqual(await (await press(token)).json(), { ok: true, value: 'keep-action' });
  await p.client.subscribe(device, expo);
  await p.client.notify({ id: 'remove-action', title: 'Approve', body: 'Request', actions: ['yes'] });
  const next = world.sent.filter((s) => s.url.startsWith('https://exp.host/')).at(-1)!.body[0].data.action;
  await p.client.unsubscribe(device);
  assert.equal((await press(next)).status, 404);
});

test('push host options only narrow the default service list', async () => {
  await assert.rejects(startRelay({ push: { hosts: ['evil.example.com'] } }), /outside default allowlist/);
  const r = await startRelay({ push: { hosts: ['fcm.googleapis.com', 'web.push.apple.com'] } });
  const p = await paired(r);
  await p.client.subscribe('phone', webSub('https://fcm.googleapis.com/p'));
  await p.client.subscribe('phone', webSub('https://web.push.apple.com/p'));
  await assert.rejects(p.client.subscribe('phone', webSub('https://other.push.apple.com/p')), /bad subscription/);
  await assert.rejects(p.client.subscribe('phone', webSub('https://updates.push.services.mozilla.com/p')), /bad subscription/);
  assert.equal(r.saved()!.push.length, 2);
});

test('a supplied invalid subscription never means remove all', async () => {
  const r = await startRelay({ push: { hosts: ['fcm.googleapis.com'] } });
  const p = await paired(r);
  const first = webSub('https://fcm.googleapis.com/first');
  const second = webSub('https://fcm.googleapis.com/second');
  await p.client.subscribe('phone', first);
  await p.client.subscribe('phone', second);
  await assert.rejects(p.client.unsubscribe('phone', webSub('https://web.push.apple.com/old')), /bad subscription/);
  await assert.rejects(p.client.unsubscribe('phone', { expo: 'ExponentPushToken[phone]', ...first }), /bad subscription/);
  await assert.rejects(p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]', ...first }), /bad subscription/);
  assert.deepEqual(r.saved()!.push.map((s) => 'web' in s && s.web.endpoint), [first.web.endpoint, second.web.endpoint]);
  await p.client.unsubscribe('phone', first);
  assert.deepEqual(r.saved()!.push.map((s) => 'web' in s && s.web.endpoint), [second.web.endpoint]);
  await p.client.unsubscribe('phone');
  assert.deepEqual(r.saved()!.push, []);
});

test('saved unapproved push destinations are removed without sending to them', async () => {
  const first = await startRelay();
  const p = await paired(first);
  const state = structuredClone(first.saved()!);
  state.push.push({ host: p.host.id, device: 'bad', added: 0, ...webSub('https://push.example.com/steal') });
  state.push.push({ host: p.host.id, device: 'mixed', added: 0, expo: 'ExponentPushToken[mixed]', ...webSub('https://push.example.com/mixed') });
  state.push.push({ host: p.host.id, device: 'good', added: 0, ...webSub('https://fcm.googleapis.com/good') });
  let saved = state;
  const requested: string[] = [];
  const r = await startRelay({ store: { load: () => saved, save: (s) => { saved = s; } }, push: {
    fetch: (async (url: string) => { requested.push(String(url)); return new Response(null, { status: 201 }); }) as typeof fetch,
  } });
  const second = await startHost(p.host.keys, p.grants);
  const h = hostClient(second, r.ws);
  await until(() => h.client.status === 'online');
  assert.deepEqual(await h.client.notify({ id: 'saved-1', title: 'Hello', body: 'World' }), { sent: 1 });
  assert.deepEqual(requested, ['https://fcm.googleapis.com/good']);
  assert.deepEqual(saved.push.map((s) => 'web' in s && s.web.endpoint), ['https://fcm.googleapis.com/good']);
  assert.equal(requested.some((url) => url.includes('exp.host')), false);
});

test('push services cannot redirect a notification to an internal address', async () => {
  const requested: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    requested.push(String(url));
    if (init.redirect !== 'error') requested.push('http://127.0.0.1/internal');
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } });
  }) as typeof fetch;
  const r = await startRelay({ push: { fetch: fake } });
  const p = await paired(r);
  await p.client.subscribe('phone', webSub('https://fcm.googleapis.com/redirect'));
  await p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]' });
  assert.deepEqual(await p.client.notify({ id: 'redirect-1', title: 'Hello', body: 'World' }), { sent: 0 });
  assert.deepEqual(requested, ['https://fcm.googleapis.com/redirect', 'https://exp.host/--/api/v2/push/send']);
});

test('a failed revoke leaves authority intact until a successful retry', async () => {
  let saved: any;
  let target: string | undefined;
  let fail = true;
  const r = await startRelay({ store: {
    load: () => saved,
    save: (s) => { if (target && !s.hosts.some((h) => h.id === target) && fail) { fail = false; throw new Error('disk failed'); } saved = s; },
  } });
  const p = await paired(r);
  const other = await paired(r);
  await p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]' });
  target = p.host.id;
  await assert.rejects(r.relay.revoke(target), /disk failed/);
  assert.equal(p.client.status, 'online');
  assert.equal(r.relay.hosts().some((h) => h.id === target), true);
  assert.equal(saved.hosts.some((h: { id: string }) => h.id === target), true);
  assert.equal(other.client.status, 'online');
  assert.equal(await r.relay.revoke(target), true);
  await until(() => p.client.status === 'refused');
  assert.deepEqual(saved.hosts.map((h: { id: string }) => h.id), [other.host.id]);
  assert.deepEqual(saved.push, []);
});

test('only the host receiving an action may answer it', async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch }, actionMs: 1000 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const a = await paired(r, 'Phone', { onAction: async () => { await blocked; return 'real'; } });
  let other!: WebSocket;
  class Captured extends WebSocket { constructor(url: string) { super(url); other = this; } }
  const b = await paired(r, 'Other', { WebSocket: Captured as any });
  await a.client.subscribe(a.grant.device.id, { expo: 'ExponentPushToken[phone]' });
  await a.client.notify({ id: 'action-1', title: 'Approve', body: 'Wait', actions: ['yes'] });
  const token = world.sent.at(-1)!.body[0].data.action;
  const press = fetch(`${r.http}/relay/v1/push/action`, { method: 'POST', body: JSON.stringify({ token, action: 'yes' }) });
  const id = await until(() => a.wire.map((s) => { try { return JSON.parse(s); } catch { return {}; } }).find((m) => m.t === 'push.action')?.id as string | undefined);
  other.send(JSON.stringify({ t: 'answer', id, ok: true, value: 'forged' }));
  let settled = false;
  void press.then(() => { settled = true; });
  await sleep(30);
  assert.equal(settled, false);
  release();
  assert.deepEqual(await (await press).json(), { ok: true, value: 'real' });
  assert.equal(b.client.status, 'online');
});

test('a delayed subscription save cannot restore a revoked host', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let saved: any;
  let entered = false;
  const r = await startRelay({ store: {
    load: () => saved,
    save: async (state) => {
      if (state.push.length && !entered) { entered = true; await blocked; }
      saved = state;
    },
  } });
  const p = await paired(r);
  const subscribing = p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]' });
  await until(() => entered);
  const revoking = r.relay.revoke(p.host.id);
  release();
  await Promise.all([subscribing.catch(() => {}), revoking]);
  assert.deepEqual(saved.hosts, []);
  assert.deepEqual(saved.push, []);
});

test('concurrent notification IDs reserve delivery and retry when no service accepts', async () => {
  let release!: () => void;
  let entered = false;
  let accept = true;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    if (calls.length === 1) { entered = true; await blocked; }
    return Response.json({ data: [{ status: accept ? 'ok' : 'error' }] });
  }) as typeof fetch;
  const r = await startRelay({ push: { fetch: fake } });
  const p = await paired(r);
  await p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]' });
  const n = { id: 'same', title: 'Hello', body: 'World' };
  const first = p.client.notify(n);
  await until(() => entered);
  assert.deepEqual(await p.client.notify(n), { sent: 0, duplicate: true });
  accept = false;
  release();
  assert.deepEqual(await first, { sent: 0 });
  accept = true;
  assert.deepEqual(await p.client.notify(n), { sent: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(await p.client.notify(n), { sent: 0, duplicate: true });
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
