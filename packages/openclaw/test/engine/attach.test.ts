// Live pinned engine + scripted provider + encrypted loopback device link; no account or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { DeviceLink, Host, keyPair, pairWithOffer, type DeviceGrant } from '@byokit/pair';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';
import type { RunFrame } from '../../src/types.ts';

// Run `npm run build` first: this integration journey is also the public SDK consumer proof.
import { OpenClawKit } from '@byokit/openclaw';
import { openclawLink } from '@byokit/openclaw/link';
import { openclawDevice, LinkRefused, words } from '@byokit/openclaw/device';
import { startModelStub, useModelStub, releaseStub, stubHolding } from '@byokit/openclaw/testing';
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 30_000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'live condition timed out'); await new Promise(r => setTimeout(r, 20)); }
};

test('oc.attach: dropped device replays then follows live, bounded history and member refusal', { timeout: 600_000 }, async () => {
  const stub = await startModelStub();
  const kit = new OpenClawKit({ stateDir: scratchDir('attach'), engineDir: sharedEngineDir(),
    tools: [{ name: 'report', description: 'Report progress', parameters: { type: 'object', properties: {} } }],
    host: { gate: async () => ({ allow: true }), call: async () => 'Umer: ready' } });
  const host = await Host.open({ keys: keyPair(), name: 'Umer computer', confirm: () => true,
    ...openclawLink(kit, { memberOf: g => (g.meta as { member: string }).member }) });
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets = new Set<WebSocket>();
  wss.on('connection', ws => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)); host.accept(ws); });
  const links: DeviceLink[] = [];
  const connect = async (grant: DeviceGrant) => {
    let online = false;
    const link = new DeviceLink(grant, { store: { save() {}, clear() {} }, onStatus: s => { online = s === 'online'; } });
    links.push(link); await until(() => online);
    return { link, device: openclawDevice(link) };
  };
  const collect = async (frames: AsyncIterable<RunFrame>) => { const out: RunFrame[] = []; for await (const f of frames) out.push(f); return out; };
  try {
    await kit.start(); await useModelStub(kit, stub); await kit.ensureMember('m1'); await kit.ensureMember('m2');
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
    const pair = async (member: string) => pairWithOffer(host.offer({ role: 'control', urls: [url], meta: { member } }).text,
      { name: 'Umer phone', onWords: () => {} });
    const grant = await pair('m1');
    const first = await connect(grant);
    const runId = 'task:attach:attempt:one';
    const message = '[tool report {}] ask permission';
    const original = first.device.run(message, { idempotencyKey: runId })[Symbol.asyncIterator]();
    const received = await original.next();
    assert.ok(!received.done && received.value.type === 'started' && received.value.seq === 1);
    for (const ws of sockets) ws.terminate(); // drop actual task-owned sockets, not the Gateway or kit
    first.link.stop(); await original.return?.();
    await until(() => stubHolding()); // tool start/end happened while the phone was absent
    assert.equal(kit.state.phase, 'ready');
    const resumed = await connect(grant);
    const frames: RunFrame[] = [received.value];
    let replayed!: () => void;
    const replayReady = new Promise<void>(r => { replayed = r; });
    const following = (async () => { for await (const f of resumed.device.attach(runId, { fromSeq: 1 })) {
      frames.push(f); if (f.type === 'tool' && f.phase === 'end') replayed();
    } })();
    await replayReady; releaseStub(); await following;
    const seqs = frames.map(f => 'seq' in f ? f.seq : -1);
    assert.deepEqual(seqs, frames.map((_, i) => i + 1));
    const terminal = frames.at(-1); assert.ok(terminal?.type === 'end' && terminal.end.ok);
    const reference = collect(resumed.device.run(message, { idempotencyKey: runId + ':reference' }));
    await until(() => stubHolding()); releaseStub();
    assert.deepEqual((await reference).at(-1), terminal, 'identical terminal frame to the unbroken device run');
    assert.deepEqual(await collect(resumed.device.attach(runId, { fromSeq: 1 })), frames.slice(1));
    assert.deepEqual(await collect(resumed.device.attach(runId, { fromSeq: seqs.at(-1)! })), []);
    const other = await connect(await pair('m2'));
    await assert.rejects(collect(other.device.attach(runId, { fromSeq: 0 })), e => e instanceof LinkRefused && e.message === words('link.notAllowed'));
    for (const fromSeq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(collect(resumed.device.attach(runId, { fromSeq })), LinkRefused);
    assert.deepEqual(await collect(resumed.device.attach('missing', { fromSeq: 0 })), [{ type: 'truncated', reason: 'not-found' }]);
    // More than the fixed 32-frame journal, using real engine tool events rather than synthetic insertion.
    const overflow = await collect(resumed.device.run('[tool report {}] '.repeat(18), { idempotencyKey: runId + ':overflow' }));
    assert.ok(overflow.length > 32 && overflow.at(-1)?.type === 'end');
    const truncated = await collect(resumed.device.attach(runId + ':overflow', { fromSeq: 0 }));
    assert.deepEqual(truncated, [{ type: 'truncated', reason: 'truncated', firstSeq: overflow.length - 31 }]);
    assert.deepEqual(await collect(resumed.device.attach(runId + ':overflow', { fromSeq: overflow.length - 32 })), overflow.slice(-32));
    await kit.stop();
    assert.deepEqual(await collect(resumed.device.attach(runId, { fromSeq: 0 })), [{ type: 'truncated', reason: 'not-found' }]);
    console.log(JSON.stringify({ entry: '@byokit/openclaw', seqs, terminal, truncated, crossMember: 'link.notAllowed', kitStayedReady: true }));
  } finally {
    releaseStub(); for (const link of links) link.stop(); host.close();
    for (const ws of sockets) ws.terminate(); wss.close(); server.close(); await kit.stop(); await stub.close();
  }
});
