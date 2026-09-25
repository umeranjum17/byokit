// A shared relay for many machines, ported from muxr's checkRemoteRelay: the owner creates five-minute, one-use
// enrolments; a machine claims one by proving its key; its address is derived from that key; the owner revokes one
// machine without touching another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostId, keyPair } from '@byokit/link';
import { CLOSE } from '../src/index.ts';
import { closed, grantStore, hostClient, paired, startHost, startRelay, until } from './helpers.ts';

const owner = 'owner-secret-for-tests';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test('a machine enrols once with an owner-created enrolment, and its relay address is derived from its key', async () => {
  let now = Date.now();
  const r = await startRelay({ ownerToken: owner, now: () => now });

  // The owner makes one over HTTP; nobody else can.
  assert.equal((await fetch(`${r.http}/relay/v1/enrolments`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${r.http}/relay/v1/enrolments`, { method: 'POST', headers: bearer('guess') })).status, 403);
  const res = await fetch(`${r.http}/relay/v1/enrolments`, { method: 'POST', headers: bearer(owner), body: JSON.stringify({ name: 'Build server' }) });
  assert.equal(res.status, 201);
  const { token, expires } = (await res.json()) as { token: string; expires: number };
  assert.equal(expires, now + 5 * 60_000);
  assert.equal((await r.relay.enrolment({ ttlMs: 600_000 })).expires, now + 5 * 60_000);
  assert.equal((await r.relay.enrolment({ ttlMs: 1000 })).expires, now + 1000);
  assert.doesNotMatch(JSON.stringify(r.saved()), new RegExp(token.split('.')[1]!), 'only a hash of the claim is kept');

  const a = await startHost();
  const ca = hostClient(a, r.ws, { enrol: token });
  await until(() => ca.client.status === 'online');
  assert.equal(ca.client.id, hostId(a.keys.publicKey));
  assert.deepEqual(r.relay.hosts().map((h) => [h.id, h.name]), [[a.id, 'Build server']]);
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
  const res = await fetch(`${r.http}/relay/v1/hosts/${b.host.id}`, { method: 'DELETE', headers: bearer(owner) });
  assert.deepEqual(await res.json(), { ok: true, removed: true });
  await until(() => b.client.status === 'refused');
  assert.equal(b.wire.length > 0 && b.seen.at(-1), 'refused');
  await until(() => b.dev.link.status === 'offline');
  assert.equal(r.relay.count(b.host.id), 0);
  // B cannot come back without a new enrolment.
  const again = hostClient(await startHost(b.host.keys, grantStore()), r.ws);
  await until(() => again.client.status === 'refused');
  // Revoking again is harmless; A never noticed.
  assert.deepEqual(await (await fetch(`${r.http}/relay/v1/hosts/${b.host.id}`, { method: 'DELETE', headers: bearer(owner) })).json(), { ok: true, removed: false });
  assert.equal(a.client.status, 'online');
  assert.deepEqual(await a.dev.link.request('still'), { op: 'still', by: a.grant.device.id });
  const list = (await (await fetch(`${r.http}/relay/v1/hosts`, { headers: bearer(owner) })).json()) as { hosts: { id: string }[] };
  assert.deepEqual(list.hosts.map((h) => h.id), [a.host.id]);
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
