// O9 device client: the sealed-notice round-trip and openNotice's refusal of tampered or malformed notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceLink } from '@byokit/pair';
import { openclawDevice } from '../src/device.ts';
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
  const altered = Buffer.from(notice.sealed, 'base64url');
  altered[altered.length - 1] ^= 1;
  assert.equal(oc.openNotice({ v: 1, sealed: altered.toString('base64url') }, seed), null);
  assert.equal(oc.openNotice(notice, crypto.getRandomValues(new Uint8Array(32))), null);
  assert.equal(oc.openNotice({ v: 1, sealed: '!!!' }, seed), null);
  assert.equal(oc.openNotice({ v: 2, sealed: notice.sealed }, seed), null);
});
