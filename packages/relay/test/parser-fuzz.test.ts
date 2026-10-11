import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyPair } from '@byokit/pair';
import { challenge, prove } from '../src/proof.ts';
import { DEFAULT_PUSH_HOSTS, isAllowedEndpoint, parseNotification, parseSubscription } from '../src/push.ts';

function random(seed: number) {
  return (max: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
}

test('seed 0x3c03: push envelope parsers reject malformed fields and unsafe destinations', () => {
  const next = random(0x3c03);
  const junk: unknown[] = [null, false, 0, '', [], {}, { web: null }, { expo: null }, { web: {}, expo: 'ExpoPushToken[a]' }];
  for (let i = 0; i < 500; i++) {
    const value = junk[next(junk.length)];
    assert.equal(parseSubscription(value), undefined);
    assert.equal(parseNotification(value), undefined);
    const endpoint = `https://fcm.googleapis.com/send/${i}`;
    const web = { web: { endpoint, keys: { p256dh: `key-${i}`, auth: `auth-${i}` } } };
    assert.deepEqual(parseSubscription(web), web);
    assert.deepEqual(parseSubscription({ expo: `ExpoPushToken[token_${i}]` }), { expo: `ExpoPushToken[token_${i}]` });
    const platform = (['ios', 'android'] as const)[next(2)];
    assert.deepEqual(parseSubscription({ expo: `ExpoPushToken[token_${i}]`, platform }), { expo: `ExpoPushToken[token_${i}]`, platform });
    assert.equal(parseSubscription({ expo: `ExpoPushToken[token_${i}]`, platform: [null, '', 'web', 'IOS', 1][next(5)] }), undefined);
    const badEndpoints = [`http://fcm.googleapis.com/${i}`, `https://fcm.googleapis.com.evil.example/${i}`,
      `https://fcm.googleapis.com@127.0.0.1/${i}`, `https://user:secret@fcm.googleapis.com/${i}`,
      `https://fcm.googleapis.com:8443/${i}`, `https://127.0.0.1/${i}`, `file:///tmp/${i}`];
    for (const bad of badEndpoints) {
      assert.equal(isAllowedEndpoint(bad), false);
      assert.equal(parseSubscription({ web: { ...web.web, endpoint: bad } }), undefined);
    }
    assert.equal(parseSubscription(web, []), undefined, 'configured subset is enforced');
    for (const field of ['p256dh', 'auth'] as const) {
      assert.equal(parseSubscription({ web: { endpoint, keys: { ...web.web.keys, [field]: '\u0000' } } }), undefined);
    }
    const notification = { id: `event-${i}`, title: `Ready ${i}`, to: [`device-${i}`], actions: ['open'], ttl: next(28 * 86_400 + 1),
      mutableContent: next(2) === 1, categoryId: `cat.${i}`, dataOnly: next(2) === 1 };
    assert.deepEqual(parseNotification(notification), notification);
    for (const patch of [{ id: '../event' }, { title: 'x'.repeat(121 + next(20)) }, { body: '\u0000' },
      { data: [] }, { data: { text: 'x'.repeat(2049) } }, { to: [null] }, { actions: Array(5).fill('open') },
      { ttl: -1 - next(100) }, { ttl: 28 * 86_400 + 1 }, { urgency: 'urgent' },
      { mutableContent: 1 }, { dataOnly: 'true' }, { categoryId: '' }, { categoryId: 'a b' }, { categoryId: 7 }]) {
      assert.equal(parseNotification({ ...notification, ...patch }), undefined, `case ${i}: ${JSON.stringify(patch).slice(0, 80)}`);
    }
    // Arbitrary JSON inputs: parsers must be total and accepted outputs must parse identically.
    const s = String.fromCharCode(...Array.from({ length: next(128) }, () => next(256)));
    for (const arbitrary of [s, { expo: s }, { web: { endpoint: s, keys: { auth: s, p256dh: s } } }, { id: s, title: s }]) {
      const sub = parseSubscription(arbitrary);
      if (sub) { assert.deepEqual(parseSubscription(sub), sub); if ('web' in sub) assert.ok(isAllowedEndpoint(sub.web.endpoint, DEFAULT_PUSH_HOSTS)); }
      const n = parseNotification(arbitrary);
      if (n) assert.deepEqual(parseNotification(n), n);
    }
  }
});

test('seed 0x3c04: host proof is bound to this challenge and key; malformed proofs fail closed', () => {
  const next = random(0x3c04);
  const keys = keyPair();
  for (let i = 0; i < 64; i++) {
    const c = challenge(), other = challenge();
    const proof = prove(keys, c.msg);
    assert.equal(c.verify(keys.publicKey, proof), true);
    assert.equal(other.verify(keys.publicKey, proof), false);
    const changed = proof.slice(); changed[next(changed.length)] ^= 1 << next(8);
    assert.equal(c.verify(keys.publicKey, changed), false);
    assert.equal(c.verify(keys.publicKey, proof.subarray(0, next(32))), false);
    assert.equal(c.verify(new Uint8Array(32), proof), false, 'low-order key');
    assert.equal(c.verify(new Uint8Array(next(32)), proof), false, 'wrong key length');
  }
});
