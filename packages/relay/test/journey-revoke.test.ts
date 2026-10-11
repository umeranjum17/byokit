// Consumer journeys for @byokit/relay's revocation path. Every import is a published entry
// (`@byokit/relay`, `@byokit/pair`): a real relay on a loopback port, a real host and phone link, and a
// fake push provider (the only stand-in, because FCM/Expo are not reachable offline). They carry the
// contracts a host app depends on: a revoked phone stops getting push even if the relay was away when it
// happened, and a revoke that cannot be saved never half-removes the phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Host, keyPair, pairWithOffer, type DeviceGrant, type Grant } from '@byokit/pair';
import { Relay, RelayClient, type RelayClientOptions, type RelayClientStore, type RelayOptions, type RelayState } from '@byokit/relay';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const v = await fn(); if (v) return v; }
  throw new Error('timed out');
}

/** A fake push provider that records every message: Expo and Web Push both accept. Nothing leaves the machine. */
function pushWorld() {
  const sent: { url: string; body: any }[] = [];
  const push = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://exp.host/')) {
      const msgs = JSON.parse(String(init?.body ?? '[]')) as any[];
      sent.push(...msgs.map((m) => ({ url: u, body: m })));
      return Response.json({ data: msgs.map(() => ({ status: 'ok' })) });
    }
    sent.push({ url: u, body: init?.body });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { sent, fetch: push };
}

/** The relay the host app runs: `Relay.open` + `attach` on a loopback port, the way an app embeds it. */
function startRelay(o: RelayOptions = {}, port = 0) {
  let saved: RelayState | undefined;
  return Relay.open({ store: { load: () => saved, save: (s) => { saved = s; } }, ...o }).then((relay) => {
    const server: Server = createServer();
    relay.attach(server);
    return new Promise<{ relay: Relay; http: string; ws: string; saved: () => RelayState | undefined; stop: () => void }>((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        const at = (server.address() as AddressInfo).port;
        resolve({ relay, http: `http://127.0.0.1:${at}`, ws: `ws://127.0.0.1:${at}`, saved: () => saved,
          stop: () => { relay.close(); server.closeAllConnections(); server.close(); } });
      });
    });
  });
}

/** A host app registered on the relay with one phone paired to it. */
async function hostWithPhone(r: Awaited<ReturnType<typeof startRelay>>, o: Partial<RelayClientOptions> = {}) {
  const grants: Grant[] = [];
  const host = await Host.open({
    keys: keyPair(), name: 'Kitchen computer',
    grants: { load: () => grants, save: (g: Grant[]) => { grants.splice(0, grants.length, ...g); } },
    confirm: () => true, handle: (req, dev) => ({ op: req.op, args: req.args, by: dev.id }),
  });
  await r.relay.admit(host.keys.publicKey, 'Kitchen computer');
  const client = new RelayClient(host, { url: `${r.ws}/relay/v1/host`, ...o });
  await until(() => client.status === 'online');
  const grant: DeviceGrant = await pairWithOffer(
    host.offer({ role: 'control', urls: [`${r.ws}/link/v1/${host.id}`] }).text, { name: 'Away phone', onWords: () => {} });
  return { host, client, grant };
}

test('a host revokes its phone: the phone stops getting push and keeps no grant', async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  try {
    const { host, client, grant } = await hostWithPhone(r);
    await client.subscribe(grant.device.id, { expo: `ExponentPushToken[${grant.device.id}]` });
    assert.deepEqual(await client.notify({ id: 'before', title: 'Hi', body: 'Hey' }), { sent: 1 });
    await client.revoke(grant.device.id);
    assert.deepEqual(await client.notify({ id: 'after', title: 'Hi' }), { sent: 0 }, 'no push after revoke');
    assert.equal(host.devices().some((d) => d.id === grant.device.id), false, 'the phone keeps no grant');
  } finally { r.stop(); }
});

test('a phone revoked while the relay is away gets no push once the relay returns', async () => {
  const world = pushWorld();
  const first = await startRelay({ push: { fetch: world.fetch } });
  const { client, grant } = await hostWithPhone(first);
  await client.subscribe(grant.device.id, { expo: `ExponentPushToken[${grant.device.id}]` });
  const port = Number(new URL(first.http).port);
  const state = first.saved();
  first.stop();
  await until(() => client.status === 'offline');
  const revoked = client.revoke(grant.device.id); // saved first, sent again on the next socket
  const r = await startRelay({ store: { load: () => state, save: () => {} }, push: { fetch: world.fetch } }, port);
  try {
    await revoked;
    assert.deepEqual(await client.notify({ id: 'after', title: 'Hi' }), { sent: 0 }, 'the re-sent unsubscribe stuck');
  } finally { r.stop(); client.stop(); }
});

test('a revoke that cannot be saved fails before the phone loses its grant', async () => {
  const world = pushWorld();
  const r = await startRelay({ push: { fetch: world.fetch } });
  try {
    const store: RelayClientStore = { load: () => [], save: () => { throw new Error('disk full'); } };
    const { host, client, grant } = await hostWithPhone(r, { store });
    await assert.rejects(client.revoke(grant.device.id), /disk full/);
    assert.equal(host.devices().some((d) => d.id === grant.device.id), true, 'nothing was half-removed');
  } finally { r.stop(); }
});
