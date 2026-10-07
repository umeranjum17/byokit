import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateGrant, GrantMigrationError, b64url, keyPair, unb64url } from '../src/index.ts';
import { b64, hash } from '../src/channel.ts';
import { connect, pairWithOffer, startHost, until } from './helpers.ts';

// Frozen pre-kit phone shape from Crewhouse's original mobile/src/link.ts.
// fp is BLAKE2b-128(host)[0:8], lowercase hex grouped in four digits (not BLAKE2b-512).
const legacy = () => ({
  sk: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  crewdPk: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
  fp: '0786 82ae f759 5c7e', urls: ['ws://127.0.0.1:8787/link', 'wss://example.test/link'],
  device: { id: 'phone-1', name: 'Pixel', role: 'view' as const },
});
const options = { format: 'crewhouse-v0' } as const;
const fingerprint = (host: string) => Array.from(hash(16, unb64url(host)).subarray(0, 8), (b) => b.toString(16).padStart(2, '0'))
  .join('').match(/.{4}/g)!.join(' ');

test('G07: migrates the original phone shape and JSON without retaining mutable input', () => {
  const raw = legacy();
  const g = migrateGrant(raw, options);
  assert.deepEqual(g, {
    v: 1, secretKey: raw.sk.slice(0, -1), host: raw.crewdPk.slice(0, -1), hostName: 'your computer',
    urls: raw.urls, device: raw.device,
  });
  assert.deepEqual(migrateGrant(JSON.stringify(raw), options), g);
  raw.urls.push('ws://changed.test/link');
  raw.device.name = 'Changed';
  assert.equal(g.urls.length, 2);
  assert.equal(g.device.name, 'Pixel');
});

test('G07: malformed, unknown and host-key-tampered inputs throw fixed typed errors', () => {
  const g = legacy();
  const inputs: unknown[] = [null, false, [], 42, '{}', '{secret-token', {}, Object.create(g),
    { ...g, v: 0 }, { ...g, v: 1 }, { ...g, token: 'secret-token' },
    { ...g, sk: 'secret-token' }, { ...g, sk: g.sk.slice(0, -1) },
    { ...g, sk: g.sk.slice(0, -2) + '9=' }, // non-canonical pad bits
    { ...g, crewdPk: b64(keyPair().publicKey) }, { ...g, fp: '0000 0000 0000 0000' },
    { ...g, urls: [] }, { ...g, urls: new Array(1) }, { ...g, urls: ['https://example.test'] },
    { ...g, urls: ['ws://'] }, { ...g, urls: ['wss://user:secret-token@example.test/link'] },
    { ...g, urls: [' ws://example.test/link'] },
    { ...g, urls: ['wss://example.test/link#secret-token'] },
    { ...g, device: null }, { ...g, device: { ...g.device, id: '' } },
    { ...g, device: { ...g.device, name: 42 } }, { ...g, device: { ...g.device, role: 'admin' } },
    { ...g, device: { ...g.device, token: 'secret-token' } },
  ];
  for (const input of inputs) assert.throws(() => migrateGrant(input, options), (e: unknown) => {
    assert.ok(e instanceof GrantMigrationError);
    assert.equal(e.code, 'invalid-grant');
    assert.doesNotMatch(e.stack ?? e.message, /secret-token|AAECAw|ICEiIy/);
    assert.deepEqual(Object.keys(e).sort(), ['code', 'name']);
    return true;
  });
  assert.throws(() => migrateGrant(g, { format: 'unknown' } as unknown as typeof options),
    (e: unknown) => e instanceof GrantMigrationError && e.code === 'unsupported-format');
});

test('G07: a migrated grant reconnects through host verification; tampered device secrets are refused', async () => {
  const h = await startHost();
  const original = await pairWithOffer(h.host.offer({ role: 'view', urls: [h.url] }).text, { name: 'Phone' });
  const raw = { sk: b64(unb64url(original.secretKey)), crewdPk: b64(unb64url(original.host)),
    fp: fingerprint(original.host), urls: original.urls, device: original.device };
  const migrated = migrateGrant(JSON.stringify(raw), options);
  assert.equal(migrated.secretKey, original.secretKey);
  assert.equal(migrated.host, original.host);
  const d = connect(migrateGrant(raw, options));
  assert.deepEqual(await d.link.request('get.state'), { op: 'get.state', by: original.device.id });
  assert.equal(d.link.grant.device.role, 'view');
  await assert.rejects(d.link.request('change'), (e: any) => e.code === 'view-only');
  d.link.stop();
  const tampered = connect(migrateGrant({ ...raw, sk: b64(keyPair().secretKey) }, options));
  await until(() => tampered.link.status === 'removed');
  assert.equal(tampered.store.g, null);
  assert.equal(h.asked.length, 1, 'migration never creates another pairing');
  assert.notEqual(b64url(unb64url(original.secretKey)), tampered.link.grant.secretKey);
});
