// Quiet hours, and the failure seam of every push transport: inside the window a notification waits
// instead of going out, high urgency still goes at once, and everything held is delivered in order once
// the window ends. A push service that fails (500, unreachable) loses the one notification, never the
// subscription, so the retry after it recovers still sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { findHost, Relay } from '../src/index.ts';
import { paired, startRelay, until } from './helpers.ts';

const webSub = (endpoint: string) => ({
  web: { endpoint, keys: { p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') } },
});

function pushWorld() {
  const sent: { url: string; body: any }[] = [];
  let mode: 'ok' | 'expo-500' | 'web-500' | 'down' = 'ok';
  const fake = (async (url: string | URL, init: RequestInit) => {
    const u = String(url);
    if (mode === 'down') throw new Error('push service unreachable');
    if (u.startsWith('https://exp.host/')) {
      if (mode === 'expo-500') return new Response('error', { status: 500 });
      const msgs = JSON.parse(String(init.body));
      sent.push({ url: u, body: msgs });
      return Response.json({ data: msgs.map(() => ({ status: 'ok' })) });
    }
    if (mode === 'web-500') return new Response('error', { status: 500 });
    sent.push({ url: u, body: init.body });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { fetch: fake, sent, set: (m: typeof mode) => { mode = m; } };
}

// 23:00 UTC is inside 22:00-07:00; 07:01 UTC is outside it.
const inside = Date.UTC(2026, 9, 6, 23, 0);
const outside = Date.UTC(2026, 9, 7, 7, 1);

test('quiet hours hold notifications inside the window and deliver them in order when it ends', async () => {
  const world = pushWorld();
  let now = inside;
  const r = await startRelay({ quietHours: { start: '22:00', end: '07:00' }, push: { fetch: world.fetch }, now: () => now });
  const p = await paired(r);
  await p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]' });

  assert.deepEqual(await p.client.notify({ id: 'first', title: 'One' }), { sent: 0, held: true });
  assert.deepEqual(await p.client.notify({ id: 'second', title: 'Two' }), { sent: 0, held: true });
  assert.deepEqual(await p.client.notify({ id: 'first', title: 'One' }), { sent: 0, duplicate: true });
  assert.equal(world.sent.length, 0, 'nothing left the relay inside the window');

  now = outside;
  assert.deepEqual(await p.client.notify({ id: 'third', title: 'Three' }), { sent: 1 });
  assert.deepEqual(world.sent.map((s) => s.body[0].collapseId), ['first', 'second', 'third'],
    'held notifications go first, in the order they waited');
  assert.deepEqual(await p.client.notify({ id: 'first', title: 'One' }), { sent: 0, duplicate: true });
});

test('high urgency bypasses quiet hours; outside the window everything sends at once', async () => {
  const world = pushWorld();
  let now = inside;
  const r = await startRelay({ quietHours: { start: '22:00', end: '07:00' }, push: { fetch: world.fetch }, now: () => now });
  const p = await paired(r);
  await p.client.subscribe('phone', webSub('https://fcm.googleapis.com/a'));

  assert.deepEqual(await p.client.notify({ id: 'urgent', title: 'Wake up', urgency: 'high' }), { sent: 1 });
  assert.deepEqual(await p.client.notify({ id: 'quiet', title: 'Later' }), { sent: 0, held: true });
  now = outside;
  assert.deepEqual(await p.client.notify({ id: 'plain', title: 'Morning' }), { sent: 1 });
  assert.equal(world.sent.length, 3);
});

test('bad quiet-hours windows fail before opening, and a held notification dies with its revoked host', async () => {
  for (const quietHours of [{ start: '9pm', end: '07:00' }, { start: '22:00', end: '7:00' }, { start: '22:00', end: '24:00' }]) {
    await assert.rejects(Relay.open({ quietHours: quietHours as any }), /bad quiet hours/);
  }
  const world = pushWorld();
  let now = inside;
  const r = await startRelay({ quietHours: { start: '22:00', end: '07:00' }, push: { fetch: world.fetch }, now: () => now });
  const p = await paired(r);
  await p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]' });
  assert.deepEqual(await p.client.notify({ id: 'waiting', title: 'Held' }), { sent: 0, held: true });
  await r.relay.revoke(p.host.id);
  await until(() => p.client.status === 'refused');
  now = outside;
  const q = await paired(r, 'Second phone');
  await q.client.subscribe('other', { expo: 'ExponentPushToken[other]' });
  assert.deepEqual(await q.client.notify({ id: 'after', title: 'After' }), { sent: 1 });
  assert.deepEqual(world.sent.map((s) => s.body[0].collapseId), ['after'],
    'the revoked host took its held notification with it');
});

test('a failing push service loses one notification, keeps the subscription, and the retry sends', async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  const p = await paired(r);
  await p.client.subscribe('phone', webSub('https://fcm.googleapis.com/a'));
  await p.client.subscribe('phone', { expo: 'ExponentPushToken[phone]' });

  world.set('expo-500');
  assert.deepEqual(await p.client.notify({ id: 'expo-down', title: 'Hi' }), { sent: 1 });
  assert.equal(r.saved()!.push.length, 2, 'the Expo token survives a 500');
  world.set('web-500');
  assert.deepEqual(await p.client.notify({ id: 'web-down', title: 'Hi' }), { sent: 1 });
  assert.equal(r.saved()!.push.length, 2, 'the Web Push subscription survives a 500');
  world.set('down');
  assert.deepEqual(await p.client.notify({ id: 'all-down', title: 'Hi' }), { sent: 0 });
  assert.equal(r.saved()!.push.length, 2, 'both survive an unreachable service');
  world.set('ok');
  assert.deepEqual(await p.client.notify({ id: 'recovered', title: 'Hi' }), { sent: 2 });
});

test('finding a host reports a wrong code, an unreachable relay, and a forged address distinctly', async () => {
  const id = 'a'.repeat(22);
  const ok = () => Response.json({ host: id });
  assert.equal(await findHost('https://relay.example', 'K7M2QX', { fetch: async () => ok() }),
    `wss://relay.example/link/v1/${id}`);
  await assert.rejects(findHost('https://relay.example', 'K7M2QX',
    { fetch: async () => new Response(null, { status: 404 }) }), /wrong or has run out/);
  await assert.rejects(findHost('https://relay.example', 'K7M2QX',
    { fetch: async () => new Response(null, { status: 500 }) }), /Couldn't reach the relay/);
  await assert.rejects(findHost('https://relay.example', 'K7M2QX',
    { fetch: async () => Response.json({ host: 'attacker' }) }), /Couldn't reach the relay/);
  await assert.rejects(findHost('https://relay.example', 'K7M2QX',
    { fetch: async () => { throw new Error('offline'); } }), /offline/);
});
