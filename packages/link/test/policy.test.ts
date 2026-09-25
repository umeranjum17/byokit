// link 0.3: host policy and device robustness. Each test is named after the muxr parity checklist row it carries
// (data/byk-muxr-parity/report.md): R = approval and revoke, M = many devices, C = reconnect, P = pairing,
// N = routes, T = transports, K = keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinkError, b64url, keyPair, keyPairFrom, pendingGrant, unb64url, type Grant, type GrantTerms } from '../src/index.ts';
import { hostKeyFile } from '../src/node.ts';
import { parseOffer } from '../src/pairing.ts';
import { connect, pairWithOffer, sleep, startHost, until } from './helpers.ts';

const paired = async (h: Awaited<ReturnType<typeof startHost>>, o: Partial<GrantTerms> = {}) =>
  pairWithOffer(h.host.offer({ role: 'control', urls: [h.url], ...o }).text, { name: 'Phone' });

test('R4: access that runs out ends like a removal, live or at the next connection', async () => {
  const h = await startHost();
  const { text } = h.host.offer({ role: 'view', urls: [h.url], lifetime: 400, kind: 'browser' });
  assert.deepEqual([parseOffer(text).role, parseOffer(text).lifetime], ['view', 400], 'the device can say what it agrees to before connecting');
  const d = connect(await pairWithOffer(text, { name: 'Browser tab' }));
  assert.equal(h.asked[0].lifetime, 400, 'and so can the person at the host');
  await until(() => d.link.status === 'online');
  const g = h.host.devices()[0];
  assert.ok(g.expires! - g.created === 400 && g.kind === 'browser');
  await until(() => d.link.status === 'removed', 3000);
  assert.equal(d.store.g, null, 'the device forgets it');
  assert.deepEqual(h.host.devices(), []);

  // Offline when it ran out: its next connection hears so from the host itself.
  const key = keyPair();
  const enrolled = await h.host.enrol({ key: key.publicKey, name: 'Old tab', role: 'view', lifetime: 50 });
  await sleep(80);
  const late = connect({ v: 1, secretKey: b64url(key.secretKey), host: b64url(h.host.keys.publicKey), hostName: '', urls: [h.url], device: { id: enrolled.id, name: 'Old tab', role: 'view' } });
  await until(() => late.link.status === 'removed');
  assert.deepEqual(h.host.devices(), []);
});

test('R4: expiry during auth save refuses ready and expired sockets receive no events', async () => {
  let now = Date.now();
  let grants: Grant[] = [];
  let pause = false;
  let entered!: () => void;
  let release!: () => void;
  const saving = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const h = await startHost({ now: () => now, grants: { load: () => grants, save: async (g) => {
    if (pause) { entered(); await gate; }
    grants = g;
  } } });
  const key = keyPair();
  const g = await h.host.enrol({ key: key.publicKey, name: 'Phone', role: 'control', lifetime: 10_000 });
  pause = true;
  const d = connect({ v: 1, secretKey: b64url(key.secretKey), host: b64url(h.host.keys.publicKey), hostName: '', urls: [h.url], device: { id: g.id, name: g.name, role: g.role } });
  await saving;
  now += 11_000;
  pause = false;
  release();
  await until(() => d.link.status === 'removed');
  assert.ok(!d.seen.includes('online'));
  await until(() => h.host.devices().length === 0);

  const live = connect(await paired(h, { lifetime: 10_000 }));
  await until(() => live.link.status === 'online');
  h.host.broadcast('before');
  await until(() => live.events.length === 1);
  now += 11_000;
  h.host.broadcast('after');
  assert.deepEqual(live.events, ['before']);
});

test('R5: an allow policy decides every request before the handler, from what the app keeps in the grant', async () => {
  const h = await startHost({
    allow: (req, g) => {
      if (req.op === 'boom') throw new Error('policy bug');
      return ((g.meta as any)?.caps ?? []).includes(req.op.split('.')[0]);
    },
  });
  const d = connect(await paired(h, { kind: 'peer', meta: { caps: ['list', 'read'] } }));
  assert.ok(await d.link.request('list.sessions'));
  await assert.rejects(d.link.request('start.session'), (e: LinkError) => e.code === 'not-allowed' && e.message === "This device isn't allowed to do that.");
  await assert.rejects(d.link.request('boom'), (e: LinkError) => e.code === 'not-allowed', 'a throwing policy refuses');
  assert.deepEqual(h.ran, ['Phone:list.sessions'], 'refused requests never reach the handler');
  assert.equal(h.errors.length, 1);
});

test('R4/R5: approval cannot outlive a changed or expired grant', async () => {
  for (const change of ['revoke', 'expire', 'meta']) {
    let release!: (yes: boolean) => void;
    let now = Date.now();
    const h = await startHost({ now: () => now, allow: () => new Promise<boolean>((r) => { release = r; }) });
    const d = connect(await paired(h, change === 'expire' ? { lifetime: 10_000 } : {}));
    await until(() => d.link.status === 'online');
    const reply = d.link.request('pay.bill');
    await until(() => !!release);
    if (change === 'expire') now += 11_000;
    else if (change === 'revoke') await h.host.revoke(d.link.grant.device.id);
    else await h.host.setMeta(d.link.grant.device.id, { caps: [] });
    release(true);
    await assert.rejects(reply, (e: LinkError) => e.code === (change === 'expire' ? 'ended' : change === 'meta' ? 'not-allowed' : 'removed'));
    assert.deepEqual(h.ran, []);
  }
});

test('R5: withdrawn policy refuses cached replies in memory and after restart', async () => {
  for (const stored of [false, true]) {
    let grants: Grant[] = [];
    const grantStore = { load: () => grants, save: (g: Grant[]) => { grants = g; } };
    const keys = keyPair();
    const kept = new Map<string, object>();
    const answers = { get: (d: string, k: string) => kept.get(`${d}/${k}`), put: (d: string, k: string, a: object) => { kept.set(`${d}/${k}`, a); },
      drop: (d: string, keys?: string[]) => { for (const k of [...kept.keys()]) if (k.startsWith(`${d}/`) && (!keys || keys.includes(k.slice(d.length + 1)))) kept.delete(k); } };
    const allow = (req: { op: string }, g: Grant) => ((g.meta as any).caps as string[]).includes(req.op);
    const opts = { keys, grants: grantStore, allow, ...(stored ? { answers } : {}) };
    const first = await startHost(opts);
    const d = connect(await paired(first, { meta: { caps: ['list'] } }));
    await until(() => d.link.status === 'online');
    first.sockets.at(-1)!.send = (() => {}) as any;
    const reply = d.link.request('list');
    await until(() => first.ran.length === 1 && (!stored || kept.size === 1));
    await first.host.setMeta(d.link.grant.device.id, { caps: [] });
    if (stored) {
      first.stop();
      const second = await startHost(opts);
      d.link.addUrl(second.url);
      await assert.rejects(reply, (e: LinkError) => e.code === 'not-allowed');
      assert.deepEqual(second.ran, []);
    } else {
      first.sockets.at(-1)!.terminate();
      await assert.rejects(reply, (e: LinkError) => e.code === 'not-allowed');
    }
    assert.deepEqual(first.ran, ['Phone:list']);
  }
});

test('M3: per-kind caps count only that kind', async () => {
  const h = await startHost({ caps: { peer: 1 } });
  await h.host.enrol({ key: keyPair().publicKey, name: 'Laptop', role: 'view', kind: 'peer' });
  await assert.rejects(h.host.enrol({ key: keyPair().publicKey, name: 'Desktop', role: 'view', kind: 'peer' }), /all the devices/);
  await assert.rejects(paired(h, { kind: 'peer' }), (e: LinkError) => e.code === 'full');
  await h.host.enrol({ key: keyPair().publicKey, name: 'Phone', role: 'control', kind: 'native' });
  assert.deepEqual(h.host.devices().map((g) => g.kind), ['peer', 'native']);
});

test('C2: requests can time out, too many waiting are refused, and a silent socket is dropped and redialled', async () => {
  const waiting: (() => void)[] = [];
  const release = () => { for (const ok of waiting.splice(0)) ok(); };
  const h = await startHost({ handle: (r) => (r.op === 'hang' ? new Promise((ok) => { waiting.push(() => ok('late')); }) : { ok: r.op }) });
  const d = connect(await paired(h), { pingMs: 100, maxPending: 2 });
  await until(() => d.link.status === 'online');
  await assert.rejects(d.link.request('hang', undefined, { timeoutMs: 100 }), (e: LinkError) => e.code === 'timeout');
  release();
  const a = d.link.request('hang'), b = d.link.request('hang');
  await assert.rejects(d.link.request('third'), (e: LinkError) => e.code === 'busy');
  await until(() => waiting.length === 2);
  release();
  await Promise.all([a, b]);

  // Half-open: the host's side goes quiet without closing. Pings go unanswered, so the device redials.
  const quiet = h.sockets.at(-1)!;
  quiet.send = (() => {}) as typeof quiet.send;
  await until(() => d.seen.includes('offline'), 2000);
  await until(() => d.link.status === 'online', 5000);
  assert.deepEqual(await d.link.request('after'), { ok: 'after' });
});

test('C2: events and mismatched pongs cannot keep a half-open socket alive', async () => {
  const h = await startHost();
  const d = connect(await paired(h), { pingMs: 100 });
  await until(() => d.link.status === 'online');
  const sealed = (h.host as any).sealed.bind(h.host);
  (h.host as any).sealed = (conn: unknown, ch: unknown, msg: any) =>
    sealed(conn, ch, msg.t === 'pong' ? { ...msg, n: msg.n + 1 } : msg);
  const events = setInterval(() => h.host.broadcast('still here'), 20);
  try {
    await until(() => d.seen.includes('offline'), 2000);
    assert.ok(d.events.length > 2);
  } finally { clearInterval(events); (h.host as any).sealed = sealed; }
});

test('C6: answers kept in a store survive a host restart; a request past its moment is not run', async () => {
  const kept = new Map<string, object>();
  const answers = { get: (d: string, k: string) => kept.get(`${d}/${k}`), put: (d: string, k: string, a: object) => { kept.set(`${d}/${k}`, a); },
    drop: (d: string, keys?: string[]) => { for (const k of [...kept.keys()]) if (k.startsWith(`${d}/`) && (!keys || keys.includes(k.slice(d.length + 1)))) kept.delete(k); } };
  let grants: Grant[] = [];
  const store = { load: () => grants, save: (g: Grant[]) => { grants = g; } };
  const keys = keyPair();
  let handledKey = '';
  const first = await startHost({ keys, answers, grants: store, handle: (r, g) => {
    handledKey = r.key!;
    first.ran.push(`${g.name}:${r.op}`);
    return { op: r.op, args: r.args, by: g.id };
  } });
  const d = connect(await paired(first));
  await until(() => d.link.status === 'online');
  first.sockets.at(-1)!.send = (() => {}) as any; // the answer is lost on the way back
  const answer = d.link.request('pay.bill', { amount: 5 });
  await until(() => first.ran.length === 1 && kept.size === 1);
  assert.ok(handledKey.startsWith(`${d.link.grant.device.id}:`));
  first.stop();
  const second = await startHost({ keys, answers, grants: store }); // the computer restarted, same key and grants
  d.link.addUrl(second.url); // T6 too: an address found later
  assert.deepEqual(await answer, { op: 'pay.bill', args: { amount: 5 }, by: d.link.grant.device.id });
  assert.equal(second.ran.length, 0, 'answered from the store, not run again');
  await d.link.request('get.x'); // carries the acknowledgement of the first answer
  await until(() => kept.size === 1, 3000); // so only this latest, unacknowledged answer is still kept

  await assert.rejects(d.link.request('send.late', undefined, { notValidAfter: Date.now() - 1 }), (e: LinkError) => e.code === 'too-late');
  assert.ok(!second.ran.includes('Phone:send.late'));
});

test('R4: a reply finishing after expiry is refused from memory or the answers store', async () => {
  for (const stored of [false, true]) {
    let now = Date.now();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const waiting = new Promise<void>((r) => { entered = r; });
    const h = await startHost({ now: () => now,
      ...(stored ? { answers: { get: async () => { entered(); await gate; return { ok: true, value: 'secret' }; }, put: () => {}, drop: () => {} } } :
        { handle: async () => { entered(); await gate; return 'secret'; } }),
    });
    const d = connect(await paired(h, { lifetime: 10_000 }));
    await until(() => d.link.status === 'online');
    const reply = d.link.request('pay.bill');
    await waiting;
    now += 11_000;
    release();
    await assert.rejects(reply, (e: LinkError) => e.code === 'ended' || e.code === 'removed');
    await until(() => d.link.status === 'removed');
  }
});

test('C6: fresh auth waits for answer deletion before accepting new requests', async () => {
  for (const fail of [false, true]) {
    let entered!: () => void, release!: () => void;
    const dropping = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const kept = new Map<string, object>();
    const h = await startHost({ answers: { get: (d, k) => kept.get(`${d}/${k}`), put: (d, k, a) => { kept.set(`${d}/${k}`, a); },
      drop: async () => { entered(); await gate; if (fail) throw new Error('drop failed'); kept.clear(); } } });
    const d = connect(await paired(h));
    const reply = d.link.request('get.state', undefined, { timeoutMs: 1000 });
    await dropping;
    assert.equal(h.ran.length, 0);
    assert.notEqual(d.link.status, 'online');
    release();
    if (fail) {
      await until(() => d.link.status === 'offline');
      await assert.rejects(reply, (e: LinkError) => e.code === 'timeout');
      assert.ok(h.errors.some((e) => (e as Error).message === 'drop failed'));
      assert.equal(h.ran.length, 0);
    } else {
      assert.ok(await reply);
      assert.equal(kept.size, 1);
    }
  }
});

test('C6: fresh deletion and another socket’s answer write are ordered per device', async () => {
  const kept = new Map<string, object>();
  let entered!: () => void, release!: () => void;
  const dropping = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let drops = 0;
  const h = await startHost({ answers: { get: (d, k) => kept.get(`${d}/${k}`), put: (d, k, a) => { kept.set(`${d}/${k}`, a); },
    drop: async () => { if (++drops === 2) { entered(); await gate; } kept.clear(); } } });
  const grant = await paired(h);
  const old = connect(grant);
  await until(() => old.link.status === 'online');
  const fresh = connect(grant);
  await dropping;
  const reply = old.link.request('get.state');
  await sleep(40);
  assert.equal(h.ran.length, 0);
  release();
  await until(() => fresh.link.status === 'online');
  assert.ok(await reply);
  assert.equal(kept.size, 1);
});

test('P6: a grant kept before pairing works after the app dies before saving the result', async () => {
  const h = await startHost();
  const { text } = h.host.offer({ role: 'control', urls: [h.url] });
  const pending = pendingGrant(text, { name: 'Phone' }); // the app saves this first
  assert.equal(pending.device.role, 'control');
  await pairWithOffer(text, { name: 'Phone', key: keyPairFrom(unb64url(pending.secretKey)) }); // …then dies before saving the result
  const d = connect(pending);
  await until(() => d.link.status === 'online');
  assert.equal(d.link.grant.device.id, h.host.devices()[0].id, 'the host fills in the id');

  // Said no instead: the kept grant hears so from the host and is forgotten.
  let approve!: (yes: boolean) => void;
  const deciding = await startHost({ confirm: () => new Promise<boolean>((resolve) => { approve = resolve; }) });
  const waiting = deciding.host.offer({ role: 'control', urls: [deciding.url] }).text;
  const saved = pendingGrant(waiting, { name: 'Phone' });
  const pairing = pairWithOffer(waiting, { name: 'Phone', key: keyPairFrom(unb64url(saved.secretKey)) });
  await until(() => !!approve);
  const restarted = connect(saved);
  await until(() => restarted.link.status === 'offline');
  assert.deepEqual(restarted.store.g, saved);
  approve(true);
  await pairing;
  restarted.link.retry();
  await until(() => restarted.link.status === 'online');
  assert.equal(restarted.link.grant.pendingUntil, undefined);

  const no = await startHost({ pairMs: 50, confirm: () => false });
  const refused = no.host.offer({ role: 'control', urls: [no.url] }).text;
  const kept = pendingGrant(refused, { name: 'Phone' });
  await assert.rejects(pairWithOffer(refused, { name: 'Phone', key: keyPairFrom(unb64url(kept.secretKey)) }));
  const orphan = connect({ ...kept, pendingUntil: Date.now() - 1 });
  await until(() => orphan.link.status === 'removed');
  assert.equal(orphan.store.g, null);
});

test('N3: a resolve hook picks the address to dial (e.g. an SSH tunnel) and the grant keeps the original', async () => {
  const h = await startHost();
  const grant = await paired(h);
  const tunnel = 'ws://tunnel.example/link';
  const dialled: string[] = [];
  const d = connect({ ...grant, urls: [tunnel] }, { resolve: (u) => { dialled.push(u); return h.url; } });
  await until(() => d.link.status === 'online');
  assert.deepEqual(dialled, [tunnel]);
  assert.deepEqual(d.link.grant.urls, [tunnel]);
});

test('T6: an address added later is tried, and a wrong host there just fails its handshake', async () => {
  const h = await startHost();
  const grant = await paired(h);
  const d = connect({ ...grant, urls: ['ws://127.0.0.1:1/nothing'] });
  await until(() => d.link.status === 'offline');
  const stranger = await startHost();
  d.link.addUrl(stranger.url);
  d.link.addUrl(h.url);
  await until(() => d.link.status === 'online', 8000);
  assert.equal(d.link.grant.urls[0], h.url);
  assert.equal(d.store.g!.urls.length, 3, 'kept');
});

test('R9: a device can unpair itself, and the host forgets it too', async () => {
  const h = await startHost();
  const d = connect(await paired(h));
  await until(() => d.link.status === 'online');
  await d.link.unpair();
  assert.equal(d.link.status, 'removed');
  assert.equal(d.store.g, null);
  assert.deepEqual(h.host.devices(), []);
});

test('R9: failed or unacknowledged unpair keeps the grant and live connection', async () => {
  let grants: Grant[] = [];
  let fail = false;
  const h = await startHost({ grants: { load: () => grants, save: (next) => {
    if (fail && !next.length) throw new Error('save failed');
    grants = next;
  } } });
  const d = connect(await paired(h));
  await until(() => d.link.status === 'online');
  fail = true;
  await assert.rejects(d.link.unpair(), (e: LinkError) => e.code === 'failed' && e.sealed);
  assert.ok(d.store.g && h.host.devices().length === 1);
  assert.ok(await d.link.request('get.state'));
  const l = (d.link as any).conn;
  const send = l.send;
  l.send = () => { throw new Error('send failed'); };
  await assert.rejects(d.link.unpair(), (e: LinkError) => e.code === 'timeout' && !e.sealed);
  l.send = send;
  assert.ok(d.store.g && h.host.devices().length === 1);
  fail = false;
  await d.link.unpair();
  assert.equal(d.store.g, null);
  assert.deepEqual(h.host.devices(), []);
  const offline = connect({ ...await paired(h), urls: ['ws://127.0.0.1:1/link'] });
  await until(() => offline.link.status === 'offline');
  await assert.rejects(offline.link.unpair(), (e: LinkError) => e.code === 'unreachable');
  assert.ok(offline.store.g);
});

test('X2a: rekey moves a device to a fresh key without a moment where no key works', async () => {
  const h = await startHost();
  const grant = await paired(h);
  const d = connect(grant);
  await until(() => d.link.status === 'online');
  await d.link.rekey();
  const now = d.link.grant;
  assert.notEqual(now.secretKey, grant.secretKey);
  assert.equal(now.nextSecretKey, undefined);
  assert.equal(h.host.devices()[0].key, b64url(keyPairFrom(unb64url(now.secretKey)).publicKey));
  assert.equal(h.host.devices()[0].nextKey, undefined);
  d.link.stop();
  const old = connect(grant);
  await until(() => old.link.status === 'removed'); // the old key is refused

  // A crash mid-rekey, host never heard: the staged key is refused, the old one still works.
  const h2 = await startHost();
  const g2 = await paired(h2);
  const staged = connect({ ...g2, nextSecretKey: b64url(keyPair().secretKey) });
  await until(() => staged.link.status === 'online');
  assert.equal(staged.link.grant.secretKey, g2.secretKey);
  assert.equal(staged.link.grant.nextSecretKey, undefined);
});

test('X2a: queued old-key auth is refused after the staged key is promoted', async () => {
  const old = keyPair(), staged = keyPair();
  const nextKey = b64url(staged.publicKey);
  let grants: Grant[] = [{ id: 'device', key: b64url(old.publicKey), nextKey, name: 'Phone', role: 'control', created: Date.now() }];
  let entered!: () => void, release!: () => void;
  const saving = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let blocked = true, authenticated = 0;
  const h = await startHost({
    grants: { load: () => grants, save: async (g) => { if (blocked && g[0]?.key === nextKey) { entered(); await gate; } grants = g; } },
    answers: { get: () => undefined, put: () => {}, drop: () => { authenticated++; } },
  });
  const device = (secretKey: Uint8Array) => ({ v: 1 as const, secretKey: b64url(secretKey), host: b64url(h.host.keys.publicKey),
    hostName: '', urls: [h.url], device: { id: 'device', name: 'Phone', role: 'control' as const } });
  const fresh = connect(device(staged.secretKey));
  await saving;
  const retired = connect(device(old.secretKey));
  await until(() => h.sockets.length === 2);
  await sleep(30);
  blocked = false;
  release();
  await until(() => fresh.link.status === 'online');
  await until(() => retired.link.status === 'removed');
  assert.equal(authenticated, 1);
  assert.equal(h.host.devices()[0].key, nextKey);
  assert.deepEqual(h.ran, []);
});

test('X2a: retired sockets cannot rekey or unpair after promotion', async () => {
  for (const action of ['rekey', 'unpair']) {
    const oldKey = keyPair(), staged = keyPair();
    const nextKey = b64url(staged.publicKey);
    let grants: Grant[] = [{ id: 'device', key: b64url(oldKey.publicKey), nextKey, name: 'Phone', role: 'control', created: Date.now() }];
    let entered!: () => void, release!: () => void;
    const saving = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let blocked = false;
    const h = await startHost({ grants: { load: () => grants, save: async (g) => {
      if (blocked && g[0]?.key === nextKey) { entered(); await gate; }
      grants = g;
    } } });
    const device = (secretKey: Uint8Array) => ({ v: 1 as const, secretKey: b64url(secretKey), host: b64url(h.host.keys.publicKey),
      hostName: '', urls: [h.url], device: { id: 'device', name: 'Phone', role: 'control' as const } });
    const old = connect(device(oldKey.secretKey));
    await until(() => old.link.status === 'online');
    blocked = true;
    const fresh = connect(device(staged.secretKey));
    await saving;
    (old.link as any).conn.send({ t: action, key: b64url(keyPair().publicKey) });
    await sleep(30);
    blocked = false;
    release();
    await until(() => fresh.link.status === 'online');
    await until(() => old.link.status !== 'online', 3000);
    await sleep(100);
    assert.deepEqual(h.host.devices().map((g) => [g.key, g.nextKey]), [[nextKey, undefined]]);
  }
});

test('X2a: enrolment with a staged key replaces the old grant', async () => {
  const old = keyPair(), staged = keyPair();
  let grants: Grant[] = [{ id: 'old', key: b64url(old.publicKey), nextKey: b64url(staged.publicKey), name: 'Phone', role: 'control', created: Date.now() }];
  const h = await startHost({ grants: { load: () => grants, save: (g) => { grants = g; } } });
  const newGrant = await h.host.enrol({ key: staged.publicKey, name: 'Phone', role: 'view' });
  assert.deepEqual(h.host.devices().map((g) => [g.id, g.role]), [[newGrant.id, 'view']]);
  const d = connect({ v: 1, secretKey: b64url(staged.secretKey), host: b64url(h.host.keys.publicKey), hostName: '', urls: [h.url], device: { id: newGrant.id, name: 'Phone', role: 'view' } });
  await until(() => d.link.status === 'online');
  await assert.rejects(d.link.request('send.message'), (e: LinkError) => e.code === 'view-only');
  assert.deepEqual(h.ran, []);
});

test('X2a: a failed staged-key save never sends rekey', async () => {
  const h = await startHost();
  const grant = await paired(h);
  const errors: unknown[] = [];
  const d = connect(grant, { store: { save: (g) => { if (g.nextSecretKey) throw new Error('save failed'); }, clear: () => {} }, onError: (e) => errors.push(e) });
  await until(() => d.link.status === 'online');
  await assert.rejects(d.link.rekey(), /save failed/);
  assert.equal(h.host.devices()[0].nextKey, undefined);
  assert.ok(errors.length);
});

test('T8: too many new handshakes from one place are turned away before any key work', async () => {
  const h = await startHost({ peers: true, handshakes: { perPeer: 2 } });
  const { text } = h.host.offer({ role: 'control', urls: [h.url] });
  await pairWithOffer(text, { name: 'One' });
  await assert.rejects(pairWithOffer(text, { name: 'Two' }), (e: LinkError) => e.code === 'expired', 'second handshake still admitted');
  await assert.rejects(pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Three' }), (e: LinkError) => e.code === 'unreachable');
  assert.equal(h.asked.length, 1);
});

test('K1: the host key file is private, reused, and never replaced when it cannot be read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-key-'));
  const path = join(dir, 'link', 'host.key');
  const a = hostKeyFile(path);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(dir, 'link')).mode & 0o777, 0o700);
  assert.deepEqual(hostKeyFile(path).publicKey, a.publicKey, 'the same key every time');
  writeFileSync(path, '{"v":1,"secretKey":"tr');
  assert.throws(() => hostKeyFile(path));
  assert.equal(readFileSync(path, 'utf8'), '{"v":1,"secretKey":"tr', 'a corrupt key is left for a person to look at');
  writeFileSync(path, '{"v":1}');
  assert.throws(() => hostKeyFile(path), /refusing to replace/);
  const link = join(dir, 'elsewhere.key');
  symlinkSync(path, link);
  assert.throws(() => hostKeyFile(link), /not a plain file/);
});

test('R4: an invalid lifetime cannot turn expiring access into unlimited access', async () => {
  const h = await startHost();
  const key = keyPair().publicKey;
  for (const lifetime of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => h.host.offer({ role: 'view', urls: [h.url], lifetime }), /positive whole number/);
    assert.throws(() => h.host.code({ role: 'view', lifetime }), /positive whole number/);
    await assert.rejects(h.host.enrol({ role: 'view', key, name: 'Phone', lifetime }), /positive whole number/);
  }
  assert.deepEqual(h.host.devices(), []);
  const unlimited = await h.host.enrol({ role: 'view', key, name: 'Phone' });
  assert.equal(unlimited.expires, undefined);
  assert.equal(h.host.offer({ role: 'view', urls: [h.url] }).expires > Date.now(), true);
});

test('K1: existing key and parent permissions must protect the host secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-permissions-'));
  const folder = join(dir, 'link');
  const path = join(folder, 'host.key');
  const key = hostKeyFile(path);
  const saved = readFileSync(path, 'utf8');
  chmodSync(path, 0o644);
  assert.throws(() => hostKeyFile(path), /allows others to read or write/);
  assert.equal(readFileSync(path, 'utf8'), saved);
  chmodSync(path, 0o600);
  for (const mode of [0o755, 0o777]) {
    chmodSync(folder, mode);
    assert.throws(() => hostKeyFile(path), /private 0700 folder/);
    assert.equal(readFileSync(path, 'utf8'), saved);
    assert.equal(lstatSync(folder).mode & 0o777, mode);
  }
  const openFolder = join(dir, 'new');
  mkdirSync(openFolder, { mode: 0o755 });
  chmodSync(openFolder, 0o755);
  assert.throws(() => hostKeyFile(join(openFolder, 'host.key')), /private 0700 folder/);
  assert.deepEqual(hostKeyFile(join(dir, 'safe.key')).publicKey.length, key.publicKey.length);
});

test('R4 (0.1 review): a store that commits after the pairing code ran out does not leave a grant', async () => {
  let grants: Grant[] = [];
  const h = await startHost({ pairMs: 150, grants: { load: () => grants, save: async (g) => { await sleep(250); grants = g; } } });
  await assert.rejects(paired(h), (e: LinkError) => e.code === 'expired' && e.sealed);
  assert.deepEqual(h.host.devices(), []);
  assert.deepEqual(grants, []);
});

test('0.1 compatibility: a device ignores what it does not know, and old offers still parse', async () => {
  const h = await startHost();
  const d = connect(await paired(h));
  await until(() => d.link.status === 'online');
  h.host.broadcast({ kind: 'x' });
  await until(() => d.events.length);
  const old = { v: 1, host: b64url(keyPair().publicKey), name: 'Old', urls: ['ws://a/link'], ticket: b64url(new Uint8Array(16)), expires: Date.now() + 60_000 };
  const parsed = parseOffer(`byokit-link:1:${Buffer.from(JSON.stringify(old)).toString('base64url')}`);
  assert.equal(parsed.role, undefined);
  assert.equal(pendingGrant(`byokit-link:1:${Buffer.from(JSON.stringify(old)).toString('base64url')}`, { name: 'P' }).device.role, 'view', 'unknown role: assume the lesser');
});
