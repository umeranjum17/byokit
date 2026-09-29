// O9 device client: op mapping over a stub link, sealed-notice round-trip, and signIn.view shapes
// through ui-core's phaseOf (waiting/code/done and the failure whys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceLink } from '@byokit/link';
import { phaseOf } from '@byokit/ui-core';
import { LinkRefused, openclawDevice } from '../src/device.ts';
import { sealNotice } from '../src/notices.ts';
import type { Approval } from '../src/types.ts';

type Req = { op: string; args: unknown };
function stubLink(o: { onRequest?: (r: Req) => unknown; streams?: Record<string, unknown> } = {}) {
  const requests: Req[] = [];
  const opened: { op: string; args: unknown }[] = [];
  const link = {
    request: async (op: string, args?: unknown): Promise<unknown> => {
      requests.push({ op, args });
      return o.onRequest?.({ op, args });
    },
    stream: async (op: string, args?: unknown): Promise<unknown> => {
      opened.push({ op, args });
      const found = o.streams?.[op];
      if (found === undefined) throw new Error(`unexpected stream: ${op}`);
      return found;
    },
  } as unknown as DeviceLink;
  return { link, requests, opened };
}

/** A scripted LinkStream: the test feeds chunks (split mid-frame) then finishes, optionally with an error. */
function scriptedStream() {
  const s = {
    onData: undefined as ((chunk: Uint8Array) => void | Promise<void>) | undefined,
    onEnd: undefined as ((error?: string) => void | Promise<void>) | undefined,
    endCalls: [] as (string | undefined)[],
    writes: [] as string[],
    async write(chunk: Uint8Array | string): Promise<void> {
      s.writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    },
    end(error?: string): void {
      s.endCalls.push(error);
    },
    feed(text: string): void {
      s.onData?.(new TextEncoder().encode(text));
    },
    finish(error?: string): void {
      s.onEnd?.(error);
    },
  };
  return s;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('requests map to link ops with the right args', async () => {
  const seen: Req[] = [];
  const { link } = stubLink({ onRequest: (r) => { seen.push(r); return null; } });
  const oc = openclawDevice(link);
  await oc.steer('agent:a:x', 'go');
  await oc.abort('agent:a:x');
  await oc.decide('id1', { allow: false, reason: 'no' });
  await oc.call('health', { a: 1 });
  assert.deepEqual(seen.map((r) => [r.op, r.args]), [
    ['oc.steer', { sessionKey: 'agent:a:x', text: 'go' }],
    ['oc.abort', { sessionKey: 'agent:a:x' }],
    ['oc.decide', { id: 'id1', allow: false, reason: 'no' }],
    ['oc.call', { method: 'health', params: { a: 1 } }],
  ]);
});

test('signIn.view shapes pass phaseOf to opening/code/waiting/done/busy/cancelled/expired/failed', async () => {
  const views = new Map<string, { ready: boolean; view: unknown }>();
  const { link } = stubLink({ onRequest: ({ op, args }) => {
    if (op === 'oc.signin.view') {
      const hit = views.get((args as { provider: string }).provider);
      if (!hit) throw new Error('no view');
      return hit;
    }
    return null;
  } });
  const oc = openclawDevice(link);
  const cases: [string, { ready: boolean; view: unknown }, string][] = [
    ['opening', { ready: false, view: { state: 'waiting', via: 'code' } }, 'opening'],
    ['code', { ready: false, view: { state: 'waiting', via: 'code', code: 'AB-CD' } }, 'code'],
    ['waiting', { ready: false, view: { state: 'waiting', via: 'browser', url: 'https://x' } }, 'waiting'],
    ['done', { ready: true, view: { state: 'done', via: 'code' } }, 'done'],
    ['busy', { ready: false, view: { state: 'failed', via: 'code', why: 'busy' } }, 'busy'],
    ['declined', { ready: false, view: { state: 'failed', via: 'code', why: 'declined' } }, 'cancelled'],
    ['expired', { ready: false, view: { state: 'failed', via: 'code', why: 'expired' } }, 'expired'],
    ['failed', { ready: false, view: { state: 'failed', via: 'code', why: 'failed' } }, 'failed'],
  ];
  for (const [provider, hit, phase] of cases) {
    views.set(provider, hit);
    assert.equal(phaseOf(await oc.signIn.view(provider)), phase, provider);
  }
});

test('run yields frames split across chunks, then the end frame', async () => {
  const s = scriptedStream();
  const { link } = stubLink({ streams: { 'oc.run': s } });
  const oc = openclawDevice(link);
  const frames: unknown[] = [];
  const done = (async () => {
    for await (const f of oc.run('hi', { sessionKey: 'agent:a:x' })) frames.push(f);
  })();
  await flush();
  s.feed('{"type":"text","tex');
  s.feed('t":"one"}\n{"type":"text","text":"two"}\n');
  await flush();
  s.feed('{"type":"end","end":{"ok":true,"text":"two"}}\n');
  s.finish();
  await done;
  assert.deepEqual(frames, [
    { type: 'text', text: 'one' },
    { type: 'text', text: 'two' },
    { type: 'end', end: { ok: true, text: 'two' } },
  ]);
  assert.deepEqual(s.endCalls, [undefined], 'the device ends its side after the end frame');
});

test('a host stream refusal raises LinkRefused with the host words', async () => {
  const s = scriptedStream();
  const { link } = stubLink({ streams: { 'oc.run': s } });
  const oc = openclawDevice(link);
  const done = (async () => {
    for await (const _ of oc.run('hi')) void _;
  })();
  await flush();
  s.finish("This device can't do that. Ask the person at the computer.");
  await assert.rejects(done, (e: unknown) => e instanceof LinkRefused && (e as Error).message.includes("can't do that"));
});

test('registerNotices sends the 32-byte box key; openNotice round-trips the approval', async () => {
  let box = '';
  const { link } = stubLink({ onRequest: ({ op, args }) => {
    if (op === 'oc.notices.register') box = (args as { boxPublicKey: string }).boxPublicKey;
    return null;
  } });
  const oc = openclawDevice(link);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  await oc.registerNotices(seed);
  assert.equal(Buffer.from(box, 'base64url').length, 32);
  await assert.rejects(oc.registerNotices(new Uint8Array(4)), /32-byte/);

  const approval: Approval = { id: 'a1', source: 'gate', member: 'a', sessionKey: 'agent:a:x',
    tool: 'note', summary: 'save a note', input: { text: 'hi' }, at: 1, expires: 2 };
  const notice = sealNotice(approval, Buffer.from(box, 'base64url'));
  assert.deepEqual(oc.openNotice(notice, seed), approval);
  assert.equal(oc.openNotice(notice, crypto.getRandomValues(new Uint8Array(32))), null);
  assert.equal(oc.openNotice({ v: 1, sealed: '!!!' }, seed), null);
  assert.equal(oc.openNotice({ v: 2, sealed: notice.sealed }, seed), null);
});
