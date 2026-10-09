// Crash-safe pairing through the built package, the way a phone app uses it: the phone process keeps its pending
// grant, is killed while the person at the computer decides, and a new process resumes against the pinned host key.
// Real processes, real sockets and the real handshakes; nothing in the pairing flow is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DeviceLink, Host, LinkError, b64url, keyPair, keyPairFrom, pairWithOffer, parseOffer, pendingGrant, unb64url, type Grant } from '@byokit/pair';
import { scratchDir, trackChild } from '../../test-support.ts';

// The phone: scan, keep the pending grant where `onPending` hands it over (when given a file), show the words.
const PHONE = `
import { writeFileSync } from 'node:fs';
import { pairWithOffer } from '@byokit/pair';
const [text, file] = process.argv.slice(1);
await pairWithOffer(text, { name: 'Umer phone', onPending: file ? (g) => writeFileSync(file, JSON.stringify(g)) : undefined, onWords: (words) => console.log(JSON.stringify({ words })) });
console.log(JSON.stringify({ paired: true }));
`;

// The phone after a restart: a live link from whatever grant it kept.
const RESUME = `
import { readFileSync, writeFileSync } from 'node:fs';
import { DeviceLink } from '@byokit/pair';
const [file] = process.argv.slice(1);
const link = new DeviceLink(JSON.parse(readFileSync(file, 'utf8')), {
  store: { save: (g) => writeFileSync(file, JSON.stringify(g)), clear: () => {} },
  onStatus: async (status) => {
    console.log(JSON.stringify({ status }));
    if (status === 'online') { console.log(JSON.stringify({ answer: await link.request('get.state') })); link.stop(); }
    if (status === 'refused') link.stop();
  },
});
`;

const cwd = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(script: string, ...args: string[]) {
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] }));
  const lines: any[] = [];
  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) lines.push(JSON.parse(buffer.slice(0, i)));
  });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  return { child, lines, exited };
}

/** A computer whose person decides only when the test says so. */
async function computer() {
  let saved: Grant[] = [];
  let asked = 0;
  let decide: (yes: boolean) => void = () => {};
  let opened: () => void;
  const asking = new Promise<void>((r) => { opened = r; });
  const host = await Host.open({
    keys: keyPair(), name: 'Umer', grants: { load: () => saved, save: (g) => { saved = g; } },
    confirm: () => { asked++; opened(); return new Promise<boolean>((r) => { decide = r; }); },
    handle: (r) => ({ op: r.op }),
  });
  return { host, asking, asked: () => asked, grants: () => saved, decide: (yes: boolean) => decide(yes) };
}

/** One address; whichever computer answers there can change, as behind a relay or a reused LAN address. */
async function address(first: Host) {
  let answering = first;
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => answering.accept(ws));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`,
    answer: (h: Host) => { answering = h; },
    drop: () => { for (const c of wss.clients) c.terminate(); },
    close: () => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(); },
  };
}

for (const kind of ['compact', 'v1'] as const) {
  test(`${kind} QR: the phone is killed while the computer asks, a new process resumes against the pinned host, an impostor there is refused`, async () => {
    const file = join(scratchDir('pair-resume'), 'grant.json');
    const umer = await computer();
    const impostor = await computer();
    const at = await address(umer.host);
    try {
      const terms = { role: 'control' as const, urls: [at.url] };
      const { text } = kind === 'compact' ? umer.host.compactOffer(terms) : umer.host.offer(terms);
      const phone = run(PHONE, text, file);
      await umer.asking;
      // Kept before the computer could say yes, pinned to the computer that held the offer.
      const pending = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(pending.host, b64url(umer.host.keys.publicKey));
      assert.ok(pending.pendingUntil > Date.now());
      assert.deepEqual(pending.device, { id: '', name: 'Umer phone', role: 'control' });
      for (let i = 0; i < 100 && phone.lines.length === 0; i++) await sleep(20);
      assert.deepEqual(phone.lines.map((l) => typeof l.words), ['string'], 'the phone shows the words, not a result');
      phone.child.kill('SIGKILL');
      await phone.exited;

      umer.decide(true); // the person says yes after the phone is gone: the yes still counts
      for (let i = 0; i < 100 && umer.grants().length === 0; i++) await sleep(20);
      assert.deepEqual(umer.grants().map((g) => g.key), [b64url(keyPairFrom(unb64url(pending.secretKey)).publicKey)]);

      // Another computer answering at the same address can't finish the pinned handshake: refused, nothing re-pinned.
      at.answer(impostor.host);
      const refused = run(RESUME, file);
      assert.equal(await refused.exited, 0);
      assert.deepEqual(refused.lines, [{ status: 'refused' }]);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), pending);
      assert.equal(impostor.asked() + impostor.grants().length, 0);

      at.answer(umer.host);
      const resumed = run(RESUME, file);
      assert.equal(await resumed.exited, 0);
      assert.deepEqual(resumed.lines, [{ status: 'online' }, { answer: { op: 'get.state' } }]);
      const kept = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(kept.host, pending.host);
      assert.equal(kept.pendingUntil, undefined);
      assert.equal(kept.device.id, umer.grants()[0]!.id);
    } finally {
      at.close();
      umer.host.close();
      impostor.host.close();
    }
  });
}

test('a phone that kept no pending grant and is killed while the computer asks leaves no grant behind', async () => {
  const umer = await computer();
  const at = await address(umer.host);
  try {
    const phone = run(PHONE, umer.host.compactOffer({ role: 'control', urls: [at.url] }).text);
    await umer.asking;
    phone.child.kill('SIGKILL');
    await phone.exited;
    umer.decide(true); // nobody holds that key any more: a grant would only fill a device slot
    await sleep(200);
    assert.deepEqual(umer.grants(), []);
  } finally {
    at.close();
    umer.host.close();
  }
});

for (const kind of ['compact', 'v1'] as const) {
  test(`${kind} QR: a phone whose socket drops while the computer asks is told it is unreachable, not that the code is spent, and resumes after the yes`, async () => {
    const umer = await computer();
    const first = await address(umer.host);
    const second = await address(umer.host);
    let link: DeviceLink | undefined;
    try {
      const terms = { role: 'view' as const, urls: [first.url, second.url] };
      const { text } = kind === 'compact' ? umer.host.compactOffer(terms) : umer.host.offer(terms);
      let kept: any;
      const pairing = pairWithOffer(text, { name: 'Umer phone', onWords: () => {}, onPending: (g) => { kept = g; } });
      await umer.asking;
      first.drop(); // the network changed: the offer is spent there, so the next address could only refuse it
      await assert.rejects(pairing, (e: LinkError) => e.code === 'unreachable' && !e.sealed);
      umer.decide(true);
      link = new DeviceLink(kept);
      for (let i = 0; i < 100 && link.status !== 'online'; i++) await sleep(20);
      assert.equal(link.status, 'online');
      assert.equal(link.grant.host, b64url(umer.host.keys.publicKey));
    } finally {
      link?.stop();
      first.close();
      second.close();
      umer.host.close();
    }
  });
}

test('a pending grant pins only a key the handshake authenticated, and a failed save stops pairing before the computer learns the phone', async () => {
  const umer = await computer();
  const at = await address(umer.host);
  try {
    const compact = umer.host.compactOffer({ role: 'view', urls: [at.url] }).text;
    assert.throws(() => pendingGrant(compact, { name: 'Umer phone' }), /doesn't carry the computer's key/);
    const v1 = umer.host.offer({ role: 'view', urls: [at.url] }).text;
    assert.throws(() => pendingGrant(v1, { name: 'Umer phone', host: b64url(keyPair().publicKey) }), (e: LinkError) => e.code === 'wrong-host');

    const full = new Error('Secure storage is full.');
    await assert.rejects(pairWithOffer(compact, { name: 'Umer phone', onWords: () => {}, onPending: () => { throw full; } }), (e) => e === full);
    await assert.rejects(pairWithOffer(v1, { name: 'Umer phone', onWords: () => {}, onPending: () => { throw full; } }), (e) => e === full);
    await sleep(100);
    assert.equal(umer.asked() + umer.grants().length, 0, 'the computer never heard of the phone');
  } finally {
    at.close();
    umer.host.close();
  }
});

test('a pending save that never settles ends pairing when the computer drops the socket; a version 1 save that never settles times out', async () => {
  const umer = await computer();
  const at = await address(umer.host);
  const settles = (p: Promise<unknown>) => Promise.race([p.then(() => 'paired', (e: LinkError) => e.code), sleep(3000).then(() => 'hung')]);
  try {
    let saving = () => {};
    const started = new Promise<void>((r) => { saving = r; });
    const pairing = pairWithOffer(umer.host.compactOffer({ role: 'view', urls: [at.url] }).text, {
      name: 'Umer phone', onWords: () => {}, onPending: () => { saving(); return new Promise<void>(() => {}); },
    });
    await started;
    at.drop();
    assert.equal(await settles(pairing), 'unreachable');
    assert.equal(umer.asked(), 0, 'the computer never heard of the phone');

    const hung = pairWithOffer(umer.host.offer({ role: 'view', urls: [at.url] }).text, {
      name: 'Umer phone', onWords: () => {}, timeoutMs: 200, onPending: () => new Promise<void>(() => {}),
    });
    assert.equal(await settles(hung), 'timeout');
    assert.equal(umer.asked(), 0);
  } finally {
    at.close();
    umer.host.close();
  }
});

test('a compact pending save that never settles times out while the socket stays open', async () => {
  const umer = await computer();
  const at = await address(umer.host);
  const settles = (p: Promise<unknown>) => Promise.race([p.then(() => 'paired', (e: LinkError) => e.code), sleep(3000).then(() => 'hung')]);
  try {
    const pairing = pairWithOffer(umer.host.compactOffer({ role: 'view', urls: [at.url] }).text, {
      name: 'Umer phone', onWords: () => {}, timeoutMs: 200, onPending: () => new Promise<void>(() => {}),
    });
    assert.equal(await settles(pairing), 'timeout');
    assert.equal(umer.asked(), 0, 'the computer never heard of the phone');
  } finally {
    at.close();
    umer.host.close();
  }
});

test('parseOffer reads a compact QR for inspection without a host key, and a version 1 offer keeps its host', async () => {
  const umer = await computer();
  const at = await address(umer.host);
  try {
    const compact = parseOffer(umer.host.compactOffer({ role: 'control', urls: [at.url] }).text, 0);
    assert.equal('host' in compact, false);
    assert.deepEqual([compact.role, compact.urls, compact.name], ['control', [at.url], 'Umer']);
    assert.ok(compact.expires > Date.now());
    assert.throws(() => parseOffer(umer.host.compactOffer({ role: 'view', urls: [at.url] }).text, Date.now() + 3_600_000), /run out/);

    const v1 = parseOffer(umer.host.offer({ role: 'control', urls: [at.url] }).text, 0);
    assert.equal('host' in v1 && v1.host, b64url(umer.host.keys.publicKey));
  } finally {
    at.close();
    umer.host.close();
  }
});
