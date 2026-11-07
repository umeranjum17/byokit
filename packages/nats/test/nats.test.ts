import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { connect } from '@nats-io/transport-node';
import { ensureNats, errorWords, NATS_ASSETS, NATS_VERSION, NatsBus, NatsError, type BusMessage, type NatsServer } from '../src/index.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'nb-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const until = async (ok: () => boolean, ms = 8000) => { for (const end = Date.now() + ms; !ok(); ) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };
const text = (m: BusMessage) => new TextDecoder().decode(m.data);

describe('the pinned download', () => {
  const root = tmp(), pack = join(root, 'pack', 'nats-server-fixture');
  mkdirSync(pack, { recursive: true });
  // A stand-in server that exits at once: enough to show the download is unpacked and run, never fetched again.
  writeFileSync(join(pack, 'nats-server'), '#!/bin/sh\necho "fixture refuses to serve" >&2\nexit 3\n');
  execFileSync('tar', ['-czf', join(root, 'fx.tgz'), '-C', join(root, 'pack'), 'nats-server-fixture']);
  const body = readFileSync(join(root, 'fx.tgz')), sha256 = createHash('sha256').update(body).digest('hex');
  let hits = 0, srv: Server;
  const listening = new Promise<string>((res) => { srv = createServer((_q, r) => { hits++; r.end(body); }).listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${(srv.address() as { port: number }).port}/a.tgz`)); });
  after(() => srv.close());
  const source = async (over = {}) => ({ url: await listening, sha256, folder: 'nats-server-fixture', ...over });

  test('every platform is pinned to the GitHub release of NATS_VERSION and a 64-hex hash', () => {
    assert.equal(NATS_VERSION, '2.15.2');
    for (const a of Object.values(NATS_ASSETS)) { assert.ok(a.url.startsWith(`https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/`)); assert.match(a.sha256, /^[0-9a-f]{64}$/); }
  });
  test('a verified download is unpacked once, run, and not fetched again', async () => {
    const stateDir = tmp(), o = { stateDir, source: await source(), startMs: 3000 };
    await assert.rejects(ensureNats(o), (e: unknown) => e instanceof NatsError && e.code === 'start-failed' && /exit 3\): fixture refuses to serve/.test(e.message));
    await assert.rejects(ensureNats(o), /fixture refuses/);
    assert.equal(hits, 1);
    assert.deepEqual(readdirSync(join(stateDir, 'nats', 'bin')).sort(), ['nats-server', 'nats-server.sha256']);
    assert.equal(statSync(join(stateDir, 'nats', 'token')).mode & 0o777, 0o600);
  });
  test('a download that fails its hash leaves nothing behind and says so', async () => {
    const stateDir = tmp();
    await assert.rejects(ensureNats({ stateDir, source: await source({ sha256: '0'.repeat(64) }) }), (e: unknown) => e instanceof NatsError && e.code === 'checksum-failed');
    assert.deepEqual(readdirSync(join(stateDir, 'nats', 'bin')), []);
    assert.match(errorWords({ code: 'checksum-failed' }), /safety check/);
  });
  test('a failed download is download-failed, an unpinned platform unsupported-platform', async () => {
    await assert.rejects(ensureNats({ stateDir: tmp(), source: await source(), fetch: async () => new Response('no', { status: 404 }) }), (e: unknown) => e instanceof NatsError && e.code === 'download-failed');
    await assert.rejects(ensureNats({ stateDir: tmp(), platform: 'win32-x64' }), (e: unknown) => e instanceof NatsError && e.code === 'unsupported-platform');
  });
  test('a relative stateDir is a programming error', async () => {
    await assert.rejects(ensureNats({ stateDir: 'rel' }), TypeError);
  });
});

// The rest runs the real pinned server; set BYOKIT_NATS_BIN to its path (CI fetches it with scripts/fetch-nats.ts).
const BIN = process.env.BYOKIT_NATS_BIN, real = BIN && existsSync(BIN) ? describe : describe.skip;
real('the real server', () => {
  const stream = { name: 'T', subjects: ['t.>'] };
  const up = async (stateDir: string): Promise<NatsServer> => ensureNats({ stateDir, bin: BIN! });
  const bus = async (s: NatsServer, more = {}) => { const b = await NatsBus.open({ url: s.url, token: s.token }); await b.ensureStream({ ...stream, ...more }); return b; };

  test('start, health, store under the caller folder, stop', async () => {
    const state = tmp(), s = await up(state);
    assert.equal(s.started, true);
    assert.match(s.url, /^nats:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(s.storeDir, join(state, 'nats', 'store'));
    assert.equal(await s.health(), true);
    await assert.rejects(connect({ servers: s.url.replace('nats://', ''), token: 'nope', maxReconnectAttempts: 0, timeout: 1500 }));
    const b = await bus(s);
    await b.publish('t.a', 'x');
    await b.close();
    assert.ok(readdirSync(join(s.storeDir, 'jetstream')).length > 0, 'JetStream wrote under the store');
    await s.stop();
    assert.equal(await s.health(), false);
    await s.stop(); // twice is fine
  });
  test('delivers once per id, replays what a reader missed, and resends a nak', async () => {
    const s = await up(tmp()), b = await bus(s);
    try {
      assert.equal((await b.publish('t.a', 'one', 'm-1')).duplicate, false);
      assert.equal((await b.publish('t.a', 'one', 'm-1')).duplicate, true);
      await b.publish('t.a', 'two', 'm-2');
      const seen: BusMessage[] = [];
      await b.reader('T', 'late', { filter: 't.a', ackWaitMs: 500 }, async (m) => { seen.push(m); if (m.deliveries === 1 && m.seq === 1) m.nak(); else await m.ack(); });
      await until(() => seen.length >= 3);
      assert.deepEqual(seen.map((m) => [text(m), m.deliveries]), [['one', 1], ['one', 2], ['two', 1]]);
    } finally { await b.close(); await s.stop(); }
  });
  test('an unacked message is sent again, and a throwing handler hands it back', async () => {
    const s = await up(tmp()), b = await bus(s);
    try {
      await b.publish('t.d', 'p');
      const tries: number[] = [];
      await b.reader('T', 'flaky', { filter: 't.d', ackWaitMs: 400 }, async (m) => { tries.push(m.deliveries); if (m.deliveries < 3) throw new Error('boom'); await m.ack(); });
      await until(() => tries.length >= 3);
      assert.deepEqual(tries.slice(0, 3), [1, 2, 3]);
    } finally { await b.close(); await s.stop(); }
  });
  test('a restarted app adopts the running server and a reader resumes its place', async () => {
    const state = tmp(), first = await up(state), b1 = await bus(first);
    assert.equal(first.started, true);
    await b1.publish('t.b', 'x', 'b-1'); await b1.publish('t.b', 'y', 'b-2');
    const got: string[] = [];
    const r = await b1.reader('T', 'keep', { filter: 't.b' }, async (m) => { got.push(text(m)); await m.ack(); });
    await until(() => got.length === 2); await r.stop();
    await b1.close(); // the app dies; the server stays
    await b1.publish('t.b', 'z', 'b-3').then(() => assert.fail('the bus is closed'), (e: unknown) => assert.equal((e as NatsError).code, 'closed'));
    const second = await up(state), b2 = await bus(second);
    try {
      assert.equal(second.started, false);
      assert.equal(second.url, first.url);
      await b2.publish('t.b', 'z', 'b-3');
      const more: string[] = [];
      await b2.reader('T', 'keep', { filter: 't.b' }, async (m) => { more.push(text(m)); await m.ack(); });
      await until(() => more.length === 1);
      assert.deepEqual(more, ['z']); // x and y were acked before, so only z comes
    } finally { await b2.close(); await second.stop(); }
  });
  test('the per-subject cap refuses the newest', async () => {
    const s = await up(tmp()), b = await bus(s, { perSubjectCap: 2 });
    try {
      await b.publish('t.c', '1'); await b.publish('t.c', '2');
      await assert.rejects(b.publish('t.c', '3'), /maximum messages per subject exceeded/);
    } finally { await b.close(); await s.stop(); }
  });
  test('a saved port taken by another program is named, never moved', async () => {
    const state = tmp(), dir = join(state, 'nats'), hog = tcp();
    await new Promise<void>((r) => hog.listen(0, '127.0.0.1', r));
    const port = String((hog.address() as { port: number }).port);
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'port'), port);
    await assert.rejects(up(state), (e: unknown) => e instanceof NatsError && e.code === 'port-taken');
    assert.equal(readFileSync(join(dir, 'port'), 'utf8'), port);
    hog.close();
  });
  test('closing never hangs: a handler that never settles, and a pending ack on a dead server', async () => {
    const s = await up(tmp()), b = await bus(s);
    await b.publish('t.e', 'stuck');
    let entered = false;
    await b.reader('T', 'stuck', { filter: 't.e' }, () => { entered = true; return new Promise<void>(() => {}); });
    await until(() => entered);
    const t0 = Date.now();
    await b.close(); // bounded by the reader grace, not by the handler
    assert.ok(Date.now() - t0 < 8000);
    await s.stop();
    // a second bus whose server dies under a reader that is mid-ack
    const s2 = await up(tmp()), b2 = await bus(s2);
    await b2.publish('t.f', 'late');
    let acking: Promise<void> | undefined;
    await b2.reader('T', 'late', { filter: 't.f' }, async (m) => { await s2.stop(); acking = m.ack(); await acking.catch(() => {}); });
    await until(() => acking !== undefined);
    await b2.close();
  });
});
