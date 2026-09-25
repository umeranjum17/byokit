// Ported from muxr's checkStrictAuth. A tunnel (cloudflared, Tailscale Serve, any reverse proxy) connects from
// 127.0.0.1, so every remote peer looks like loopback: the relay must never let a host register on where it comes
// from. Only a proof of the host's key counts, and each proof is good for one socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostId, keyPair } from '@byokit/link';
import { CLOSE } from '../src/index.ts';
import { prove, type Challenge } from '../src/proof.ts';
import { closed, startRelay } from './helpers.ts';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** A raw host socket from loopback that answers the challenge with `hello`, and what the relay did with it. */
async function register(url: string, hello: (c: Challenge) => object): Promise<{ ready?: any; close?: [number, string]; c?: Challenge }> {
  const ws = new WebSocket(`${url}/relay/v1/host`);
  return new Promise((resolve) => {
    let c: Challenge | undefined;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t === 'challenge') { c = m; ws.send(JSON.stringify(hello(m))); }
      if (m.t === 'ready') { resolve({ ready: m, c }); ws.close(); }
    });
    ws.addEventListener('close', (e) => resolve({ close: [e.code, e.reason], c }));
  });
}

test('strict auth holds for tunnelled peers: no proof, a forged proof, a replayed proof and an unknown host are refused', async () => {
  const r = await startRelay({ ownerToken: 'owner' });
  const keys = keyPair();
  await r.relay.admit(keys.publicKey);
  const key = b64u(keys.publicKey);

  assert.deepEqual((await register(r.ws, () => ({ t: 'hello', key }))).close, [4400, 'bad hello'], 'tokenless host from loopback');
  assert.deepEqual((await register(r.ws, () => ({ t: 'hello', key, proof: b64u(new Uint8Array(32)) }))).close, [CLOSE.badProof, 'bad proof'], 'forged proof');
  assert.deepEqual((await register(r.ws, () => ({ t: 'hello', key: b64u(new Uint8Array(32)), proof: b64u(new Uint8Array(32)) }))).close, [CLOSE.badProof, 'bad proof'], 'a key with no secret behind it');

  // A valid proof works once; the same proof on the next socket (a new challenge) does not.
  const good = await register(r.ws, (c) => ({ t: 'hello', key, proof: b64u(prove(keys, c)) }));
  assert.equal(good.ready?.id, hostId(keys.publicKey));
  const stolen = b64u(prove(keys, good.c!));
  assert.deepEqual((await register(r.ws, () => ({ t: 'hello', key, proof: stolen }))).close, [CLOSE.badProof, 'bad proof'], 'replayed proof');

  // A real key that nobody enrolled.
  const stranger = keyPair();
  assert.deepEqual((await register(r.ws, (c) => ({ t: 'hello', key: b64u(stranger.publicKey), proof: b64u(prove(stranger, c)) }))).close, [CLOSE.notEnrolled, 'not enrolled']);
  // Enrolment is not guessable either.
  const { token } = await r.relay.enrolment();
  const forged = `${token.split('.')[0]}.${b64u(new Uint8Array(32))}`;
  assert.deepEqual((await register(r.ws, (c) => ({ t: 'hello', key: b64u(stranger.publicKey), proof: b64u(prove(stranger, c)), enrol: forged }))).close, [CLOSE.enrolment, 'enrolment expired or used']);

  // Owner routes answer only the owner's token.
  assert.equal((await fetch(`${r.http}/relay/v1/hosts`)).status, 403);
  assert.equal((await fetch(`${r.http}/relay/v1/hosts`, { headers: { authorization: 'Bearer owner' } })).status, 200);
  const none = await startRelay();
  assert.equal((await fetch(`${none.http}/relay/v1/hosts`, { headers: { authorization: 'Bearer ' } })).status, 403, 'no owner token: no owner routes');
});

test('failed proofs are limited per address, like muxr limits failed ticket mints', async () => {
  const r = await startRelay();
  const keys = keyPair();
  const bad = () => register(r.ws, () => ({ t: 'hello', key: b64u(keys.publicKey), proof: b64u(new Uint8Array(32)) }));
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await bad()).close![0]);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(CLOSE.badProof));
  assert.deepEqual(codes.slice(10), [CLOSE.tooMany, CLOSE.tooMany]);
});

test('a device socket cannot act as a host: what it sends is only ever a frame for the host it dialled', async () => {
  const r = await startRelay();
  const keys = keyPair();
  await r.relay.admit(keys.publicKey);
  const d = new WebSocket(`${r.ws}/link/v1/${hostId(keys.publicKey)}`);
  assert.deepEqual(await closed(d), [1013, 'host offline']);
  assert.equal(r.relay.hosts()[0]!.online, false);
});
