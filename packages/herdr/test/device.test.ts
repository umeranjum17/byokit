// H7 acceptance (docs/runtime-kits.md 11.3, behavior 7.2) for src/device.ts: each device method opens the right
// link op with the right args, notices derive the box key from the seed, and envelopes that are not ours open to
// null. Socket behavior lives in test/link.test.ts; bundle portability in test/portable.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxKeyPairFromSeed } from '@byokit/seal';
import type { DeviceLink, LinkStream } from '@byokit/link';
import { herdrDevice } from '../src/device.ts';
import { boxPublicKeyB64, openNotice, sealNotice } from '../src/notices.ts';
import type { BlockedAgent } from '../src/types.ts';

type Call = { op: string; args: unknown };
const stubLink = (answer: (call: Call) => unknown, streams: Record<string, string[]> = {}): {
  link: DeviceLink; calls: Call[]; opened: Call[];
} => {
  const calls: Call[] = [];
  const opened: Call[] = [];
  const link = {
    request: async (op: string, args?: unknown): Promise<unknown> => {
      calls.push({ op, args });
      return answer({ op, args });
    },
    stream: async (op: string, args?: unknown): Promise<LinkStream> => {
      opened.push({ op, args });
      const lines = streams[op] ?? [];
      const s = {
        onData: undefined as unknown as (chunk: Uint8Array) => void,
        onEnd: undefined as unknown as () => void,
        write: async () => {},
        end: () => {},
      } as unknown as LinkStream;
      // Deliver queued lines on a timer so the device sets its handlers first; without a
      // frame the events generator below would wait forever (breaking a for-await parked in
      // an unsettled await never completes).
      setTimeout(() => {
        for (const line of lines) s.onData?.(new TextEncoder().encode(`${line}\n`));
        s.onEnd?.();
      }, 0);
      return s;
    },
  } as unknown as DeviceLink;
  return { link, calls, opened };
};

const BLOCKED: BlockedAgent = {
  paneId: 'w1:p2', workspaceId: 'w1', tabId: 'w1:t1', kind: 'pi', revision: 4,
  prompt: 'Allow this? (y/n)', since: 1700000000000,
};

test('each method opens its op with the right args', async () => {
  const { link, calls, opened } = stubLink(({ op }) => {
    if (op === 'hd.state') return { state: { phase: 'ready' }, words: 'Connected to Herdr.' };
    if (op === 'hd.tree') return { connected: true, workspaces: [] };
    if (op === 'hd.agent.start') return { paneId: 'w2:p1' };
    if (op === 'hd.prompt') return { paneId: 'w1:p2', terminalId: 't', revision: 1, status: 'working' };
    if (op === 'hd.read') return { text: 'hi', truncated: false };
    if (op === 'hd.blocked') return [];
    if (op === 'hd.call') return { protocol: 22 };
    return null;
  }, { 'hd.events': ['{"type":"snapshot"}'] });
  const hd = herdrDevice(link);
  assert.equal((await hd.state()).words, 'Connected to Herdr.');
  assert.deepEqual((await hd.tree()).workspaces, []);
  assert.deepEqual(await hd.startAgent({ kind: 'pi', cwd: '/tmp', place: { workspace: 'new' } }), { paneId: 'w2:p1' });
  assert.equal((await hd.prompt('w1:p2', 'go')).status, 'working');
  await hd.keys('w1:p2', ['y']);
  assert.deepEqual(await hd.read('w1:p2', { source: 'detection', lines: 40 }), { text: 'hi', truncated: false });
  assert.deepEqual(await hd.blocked(), []);
  await hd.answer('w1:p2', ['y'], 4);
  await hd.close({ tab: 'w1:t1' });
  await hd.registerNotices(new Uint8Array(32).fill(5));
  assert.deepEqual(await hd.call('ping', {}), { protocol: 22 });
  for await (const _ of hd.events()) break;   // generators open the stream on first pull
  hd.terminal('w1:p1', { mode: 'observe', cols: 80, rows: 24 }).close();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((c) => c.op), [
    'hd.state', 'hd.tree', 'hd.agent.start', 'hd.prompt', 'hd.keys', 'hd.read', 'hd.blocked',
    'hd.answer', 'hd.close', 'hd.notices.register', 'hd.call',
  ]);
  assert.deepEqual(calls[4], { op: 'hd.keys', args: { paneId: 'w1:p2', keys: ['y'] } });
  assert.deepEqual(calls[7], { op: 'hd.answer', args: { paneId: 'w1:p2', keys: ['y'], revision: 4 } });
  assert.deepEqual(calls[9], {
    op: 'hd.notices.register',
    args: { boxPublicKey: boxPublicKeyB64(new Uint8Array(32).fill(5)) },
  });
  assert.deepEqual(opened.map((c) => c.op), ['hd.events', 'hd.terminal']);
  assert.deepEqual(opened[1], { op: 'hd.terminal', args: { paneId: 'w1:p1', mode: 'observe', cols: 80, rows: 24 } });
});

test('registerNotices refuses a bad seed before any request', async () => {
  const { link, calls } = stubLink(() => null);
  const hd = herdrDevice(link);
  await assert.rejects(hd.registerNotices(new Uint8Array(7)), /32 bytes/);
  await assert.rejects(hd.registerNotices('seed' as unknown as Uint8Array), /32 bytes/);
  assert.deepEqual(calls, []);
});

test('openNotice recovers a sealed notice and rejects anything else', () => {
  const seed = new Uint8Array(32).fill(5);
  const sealed = sealNotice(BLOCKED, boxKeyPairFromSeed(seed).publicKey);
  assert.deepEqual(openNotice(sealed, seed), BLOCKED);
  assert.equal(hdOpen(sealed, new Uint8Array(32).fill(6)), null);
  assert.equal(openNotice({ v: 1, sealed: '!!!' }, seed), null);
  assert.equal(openNotice({ v: 2, sealed: sealed.sealed }, seed), null);
  assert.equal(openNotice({ v: 1 }, seed), null);
  assert.equal(openNotice(sealed, new Uint8Array(7)), null);
  // Sealed under another key never parses as ours.
  const other = sealNotice(BLOCKED, boxKeyPairFromSeed(new Uint8Array(32).fill(6)).publicKey);
  assert.equal(openNotice(other, seed), null);
});

const hdOpen = (data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null => {
  const { link } = stubLink(() => null);
  return herdrDevice(link).openNotice(data, seed);
};

test('sealNotice refuses a bad key', () => {
  assert.throws(() => sealNotice(BLOCKED, new Uint8Array(7)), /32 bytes/);
  assert.throws(() => sealNotice({} as unknown as BlockedAgent, new Uint8Array(32)), /cannot seal/);
});
