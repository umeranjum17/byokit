// A shared relay for many machines, ported from muxr's checkRemoteRelay: the owner creates five-minute, one-use
// enrolments; a machine claims one by proving its key; its address is derived from that key; the owner revokes one
// machine without touching another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostId, keyPair, pairWithOffer, DeviceLink } from '@byokit/pair';
import { CLOSE, MAX_ENROLMENT_META_BYTES, ownerClient, RelayOwnerError } from '../src/index.ts';
import { closed, grantStore, hostClient, paired, startHost, startRelay, until } from './helpers.ts';

const owner = 'owner-secret-for-tests';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test('a machine enrols once with an owner-created enrolment, and its relay address is derived from its key', async () => {
  let now = Date.now();
  const r = await startRelay({ ownerToken: owner, now: () => now });

  // The owner makes one over HTTP; nobody else can.
  assert.equal((await fetch(`${r.http}/relay/v1/enrolments`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${r.http}/relay/v1/enrolments`, { method: 'POST', headers: bearer('guess') })).status, 403);
  const client = ownerClient(r.http, owner);
  assert.deepEqual(await client.hosts(), []);
  const { token, expires } = await client.enrolment({ name: 'Build server' });
  assert.equal(expires, now + 5 * 60_000);
  assert.equal((await r.relay.enrolment({ ttlMs: 600_000 })).expires, now + 5 * 60_000);
  assert.equal((await r.relay.enrolment({ ttlMs: 1000 })).expires, now + 1000);
  assert.doesNotMatch(JSON.stringify(r.saved()), new RegExp(token.split('.')[1]!), 'only a hash of the claim is kept');

  const a = await startHost();
  const ca = hostClient(a, r.ws, { enrol: token });
  await until(() => ca.client.status === 'online');
  assert.equal(ca.client.id, hostId(a.keys.publicKey));
  assert.deepEqual(r.relay.hosts().map((h) => [h.id, h.name]), [[a.id, 'Build server']]);
  assert.deepEqual(await client.hosts(), r.relay.hosts());
  assert.equal(r.saved()!.enrolments.length, 2, 'only this claim is used up');

  // A replay by another machine is refused, and so is a machine with no enrolment at all.
  const b = await startHost();
  const replay = hostClient(b, r.ws, { enrol: token });
  await until(() => replay.client.status === 'refused');
  const none = hostClient(await startHost(), r.ws);
  await until(() => none.client.status === 'refused');
  assert.equal(r.relay.hosts().length, 1);

  // An expired one is refused, and gone once tried.
  const late = await r.relay.enrolment({ name: 'Laptop' });
  now += 5 * 60_000 + 1;
  const tooLate = hostClient(b, r.ws, { enrol: late.token });
  await until(() => tooLate.client.status === 'refused');
  assert.equal(r.saved()!.enrolments.some((e) => e.id === late.token.split('.')[0]), false);

  // Once enrolled, the machine reconnects with no enrolment.
  ca.client.stop();
  const back = hostClient(a, r.ws);
  await until(() => back.client.status === 'online');
});

test('two machines claiming one enrolment at once: exactly one gets it', async () => {
  const r = await startRelay();
  const { token } = await r.relay.enrolment();
  const clients = await Promise.all([startHost(), startHost()]).then((hs) => hs.map((h) => hostClient(h, r.ws, { enrol: token })));
  await until(() => clients.every((c) => c.client.status === 'online' || c.client.status === 'refused'));
  assert.deepEqual(clients.map((c) => c.client.status).sort(), ['online', 'refused']);
  assert.equal(r.relay.hosts().length, 1);
});

test('revoking machine B closes B and its devices, refuses B from then on, and leaves machine A alone', async () => {
  const r = await startRelay({ ownerToken: owner });
  const a = await paired(r, 'Phone A');
  const b = await paired(r, 'Phone B');
  await b.dev.link.request('hello');
  const client = ownerClient(r.http, owner);
  assert.equal(await client.revoke(b.host.id), true);
  await until(() => b.client.status === 'refused');
  assert.equal(b.wire.length > 0 && b.seen.at(-1), 'refused');
  await until(() => b.dev.link.status === 'offline');
  assert.equal(r.relay.count(b.host.id), 0);
  // B cannot come back without a new enrolment.
  const again = hostClient(await startHost(b.host.keys, grantStore()), r.ws);
  await until(() => again.client.status === 'refused');
  // Revoking again is harmless; A never noticed.
  assert.equal(await client.revoke(b.host.id), false);
  assert.equal(a.client.status, 'online');
  assert.deepEqual(await a.dev.link.request('still'), { op: 'still', by: a.grant.device.id });
  assert.deepEqual((await client.hosts()).map((h) => h.id), [a.host.id]);
});

test('owner client reports typed HTTP refusals and injects fetch for every operation', async () => {
  const r = await startRelay({ ownerToken: owner });
  const denied = ownerClient(r.http, 'guess');
  for (const call of [() => denied.hosts(), () => denied.enrolment(), () => denied.revoke('a'.repeat(22))]) {
    await assert.rejects(call(), (e: unknown) => e instanceof RelayOwnerError && e.status === 403 && e.code === 'forbidden');
  }
  await assert.rejects(ownerClient(r.http, owner).revoke('not-a-host'),
    (e: unknown) => e instanceof RelayOwnerError && e.status === 404 && e.code === 'not-found');
  const calls: { url: string; init: RequestInit }[] = [];
  const client = ownerClient('https://relay.example/ignored', owner, { fetch: async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return Response.json(init!.method === 'GET' ? { hosts: [] } : init!.method === 'POST' ? { token: 'one-use', expires: 123 } : { removed: false });
  } });
  assert.deepEqual(await client.hosts(), []);
  assert.deepEqual(await client.enrolment(), { token: 'one-use', expires: 123 });
  await client.enrolment({ name: 'Laptop' });
  assert.equal(await client.revoke('unknown/id'), false);
  assert.deepEqual(calls.map((c) => [c.url, c.init.method, c.init.body]), [
    ['https://relay.example/relay/v1/hosts', 'GET', undefined],
    ['https://relay.example/relay/v1/enrolments', 'POST', '{}'],
    ['https://relay.example/relay/v1/enrolments', 'POST', '{"name":"Laptop"}'],
    ['https://relay.example/relay/v1/hosts/unknown%2Fid', 'DELETE', undefined],
  ]);
  for (const c of calls) {
    assert.equal(new Headers(c.init.headers).get('authorization'), `Bearer ${owner}`);
    assert.equal(c.init.redirect, 'error', 'do not forward the owner token through redirects');
  }
  assert.equal(new Headers(calls[2]!.init.headers).get('content-type'), 'application/json');
  for (const status of [404, 500]) {
    const absent = ownerClient(r.http, owner, { fetch: async () => new Response('private-server-error', { status }) });
    await assert.rejects(absent.hosts(), (e: unknown) => e instanceof RelayOwnerError && e.status === status
      && e.code === (status === 404 ? 'not-found' : 'request-failed') && !e.message.includes('private-server-error'));
  }
  const offline = new Error('offline');
  await assert.rejects(ownerClient(r.http, owner, { fetch: async () => { throw offline; } }).hosts(), (e) => e === offline);
  assert.throws(() => ownerClient('wss://relay.example', owner));
  assert.throws(() => ownerClient('https://user:password@relay.example', owner));
});

test('revocation during an enrolment save cannot install a live host', async () => {
  let release!: () => void;
  let saved: any;
  let entered = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const r = await startRelay({ store: {
    load: () => saved,
    save: async (state) => { if (state.hosts.length) { entered = true; await blocked; } saved = state; },
  } });
  const { token } = await r.relay.enrolment();
  const host = await startHost();
  const client = hostClient(host, r.ws, { enrol: token });
  await until(() => entered);
  assert.equal(r.relay.hosts().length, 0, 'admission is not visible before its save');
  const revoked = r.relay.revoke(host.id);
  release();
  await revoked;
  await until(() => client.client.status === 'refused');
  assert.equal(r.relay.hosts().length, 0);
  assert.equal(r.relay.count(host.id), 0);
  assert.deepEqual(saved.hosts, []);
});

test('failed direct admission and enrolment creation leave no in-memory authority', async () => {
  let saved: any;
  let fail = false;
  const r = await startRelay({ store: {
    load: () => saved,
    save: (s) => { if (fail) { fail = false; throw new Error('disk failed'); } saved = s; },
  } });
  const key = keyPair();
  fail = true;
  await assert.rejects(r.relay.admit(key.publicKey), /disk failed/);
  assert.deepEqual(r.relay.hosts(), []);
  assert.deepEqual(saved.hosts, []);
  fail = true;
  await assert.rejects(r.relay.enrolment(), /disk failed/);
  assert.deepEqual(saved.enrolments, []);
  const { token } = await r.relay.enrolment();
  assert.equal(saved.enrolments.length, 1);
  const client = hostClient(await startHost(key), r.ws, { enrol: token });
  await until(() => client.client.status === 'online');
});

test('failed enrolment admission leaves the claim and authority unchanged', async () => {
  let saved: any;
  let fail = true;
  const r = await startRelay({ store: {
    load: () => saved,
    save: (s) => { if (s.hosts.length && fail) { fail = false; throw new Error('disk failed'); } saved = s; },
  } });
  const { token } = await r.relay.enrolment();
  const host = await startHost();
  const first = hostClient(host, r.ws, { enrol: token });
  await until(() => first.client.status === 'offline');
  first.client.stop();
  assert.equal(r.relay.hosts().length, 0);
  assert.equal(saved.enrolments.length, 1);
  const noClaim = hostClient(host, r.ws);
  await until(() => noClaim.client.status === 'refused');
  assert.equal(r.relay.hosts().length, 0);
  const retry = hostClient(host, r.ws, { enrol: token });
  await until(() => retry.client.status === 'online');
  assert.equal(r.relay.hosts().length, 1);
  assert.deepEqual(saved.enrolments, []);
});

test('a machine cannot register under another machine\'s address: the proof is for the key it presents', async () => {
  const r = await startRelay();
  const victim = keyPair();
  await r.relay.admit(victim.publicKey);
  // The attacker knows the victim's public key (and so its address) but not its secret key.
  const ws = new WebSocket(`${r.ws}/relay/v1/host`);
  const { prove } = await import('../src/proof.ts');
  const mine = keyPair();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === 'challenge') {
      ws.send(JSON.stringify({ t: 'hello', key: Buffer.from(victim.publicKey).toString('base64url'), proof: Buffer.from(prove(mine, m)).toString('base64url') }));
    }
  });
  assert.deepEqual(await closed(ws), [CLOSE.badProof, 'bad proof']);
  assert.equal(r.relay.hosts()[0]!.online, false);
});

test('open signup caps concurrent registrations, permits reconnects, and frees slots on revoke', async () => {
  const r = await startRelay({ signup: { open: true, maxHosts: 1 } });
  const hs = await Promise.all([startHost(), startHost()]);
  const cs = hs.map((h) => hostClient(h, r.ws));
  await until(() => cs.every((c) => ['online', 'refused'].includes(c.client.status)));
  assert.deepEqual(cs.map((c) => c.client.status).sort(), ['online', 'refused']);
  const admitted = cs.findIndex((c) => c.client.status === 'online');
  cs[admitted]!.client.stop();
  const back = hostClient(hs[admitted]!, r.ws);
  await until(() => back.client.status === 'online');
  assert.equal(r.relay.hosts().length, 1);
  await r.relay.revoke(hs[admitted]!.id);
  const next = hostClient(hs[1 - admitted]!, r.ws);
  await until(() => next.client.status === 'online');
  assert.equal(r.relay.hosts().length, 1);
});

test('explicit closed signup requires enrolment and invalid caps fail before opening', async () => {
  for (const signup of ['enrol' as const, { open: false, maxHosts: 1 }]) {
    const r = await startRelay({ signup });
    const h = await startHost();
    const denied = hostClient(h, r.ws);
    await until(() => denied.client.status === 'refused');
    const { token } = await r.relay.enrolment();
    const enrolled = hostClient(h, r.ws, { enrol: token });
    await until(() => enrolled.client.status === 'online');
  }
  for (const maxHosts of [0, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(startRelay({ signup: { open: true, maxHosts } }), /bad signup policy/);
  }

});


test('owner enrolment metadata is capped JSON, retained on reconnect, and never routed to devices', async () => {
  const r = await startRelay({ ownerToken: owner });
  const meta = { enrolmentUrl: 'https://relay.example/enrol', webUrl: 'https://app.example', marker: 'host-only-canary' };
  const token = (await ownerClient(r.http, owner).enrolment({ meta })).token;
  const host = await startHost();
  const h = hostClient(host, r.ws, { enrol: token });
  await until(() => h.client.status === 'online');
  assert.deepEqual(h.client.meta, meta);
  assert.deepEqual((await h.client.self()).host.meta, meta);
  assert.deepEqual(r.saved()!.hosts[0]!.meta, meta);
  const grant = await pairWithOffer(host.offer({ role: 'control', urls: [`${r.ws}/link/v1/${host.id}`] }).text, { name: 'Phone', onWords: () => {} });
  const link = new DeviceLink(grant);
  try {
    assert.doesNotMatch(JSON.stringify(grant), /host-only-canary/);
    assert.doesNotMatch(JSON.stringify(await link.request('self')), /host-only-canary/);
    assert.doesNotMatch(JSON.stringify(await (await fetch(`${r.http}/relay/v1/codes/${(await h.client.code()).code}`)).json()), /host-only-canary/);
  } finally { link.stop(); }
  h.client.stop();
  const next = hostClient(host, r.ws);
  await until(() => next.client.status === 'online');
  assert.deepEqual(next.client.meta, meta);
  const max = 'a'.repeat(MAX_ENROLMENT_META_BYTES - 2); // quotes are two bytes
  await r.relay.enrolment({ meta: max });
  await assert.rejects(r.relay.enrolment({ meta: max + 'a' }), /metadata/);
  await assert.rejects(r.relay.enrolment({ meta: 'é'.repeat(2048) }), /metadata/);
  const cycle: any = {}; cycle.self = cycle;
  await assert.rejects(r.relay.enrolment({ meta: cycle }));
  await assert.rejects(ownerClient(r.http, owner).enrolment({ meta: max + 'a' }), (e: unknown) => e instanceof RelayOwnerError && e.status === 400);
  const raw = new WebSocket(`${r.ws}/relay/v1/host`);
  raw.addEventListener('message', () => raw.send(JSON.stringify({ t: 'self', id: host.id })));
  assert.deepEqual(await closed(raw), [4400, 'bad hello']);
});

test('self returns only the key-proven host, and counts live connections rather than grants', async () => {
  const r = await startRelay();
  const a = await paired(r);
  const b = await paired(r);
  await a.dev.link.request('hello');
  await b.dev.link.request('hello');
  // Pairing uses a temporary socket; wait for its close to reach the relay.
  await until(async () => (await a.client.self()).devices === 1);
  const self = await a.client.self();
  const { online, devices, ...record } = r.relay.hosts().find((h) => h.id === a.host.id)!;
  assert.equal(online, true);
  assert.deepEqual(self, { host: record, devices });
  assert.equal(self.devices, 1);
  assert.doesNotMatch(JSON.stringify(self), new RegExp(b.host.id));
  a.dev.link.stop();
  await until(async () => (await a.client.self()).devices === 0);
});


test('open signup still claims explicit owner enrolment metadata and consumes its token', async () => {
  const r = await startRelay({ signup: { open: true, maxHosts: 1 } });
  const meta = { enrolmentUrl: 'https://relay.example/enrol' };
  const { token } = await r.relay.enrolment({ name: 'Owner name', meta });
  const host = await startHost();
  const h = hostClient(host, r.ws, { enrol: token, name: 'Host name' });
  await until(() => h.client.status === 'online');
  assert.deepEqual(h.client.meta, meta);
  assert.equal((await h.client.self()).host.name, 'Owner name');
  assert.deepEqual(r.saved()!.enrolments, []);
});
