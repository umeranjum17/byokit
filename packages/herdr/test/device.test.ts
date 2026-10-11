// H7 acceptance (docs/runtime-kits.md 11.3, behavior 7.2) for src/device.ts: envelopes that are not ours open to
// null. Socket behavior lives in test/link.test.ts; bundle portability in test/portable.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxKeyPairFromSeed } from '@byokit/seal';
import type { DeviceLink } from '@byokit/pair';
import { herdrDevice } from '../src/device.ts';
import { openNotice, sealNotice } from '../src/notices.ts';
import type { BlockedAgent } from '../src/types.ts';

const BLOCKED: BlockedAgent = {
  paneId: 'w1:p2', workspaceId: 'w1', tabId: 'w1:t1', kind: 'pi', revision: 4,
  prompt: 'Allow this? (y/n)', since: 1700000000000,
};

// openNotice through the device needs no link round-trip.
const hdOpen = (data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null =>
  herdrDevice({} as unknown as DeviceLink).openNotice(data, seed);

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

test('sealNotice refuses a bad key', () => {
  assert.throws(() => sealNotice(BLOCKED, new Uint8Array(7)), /32 bytes/);
  assert.throws(() => sealNotice({} as unknown as BlockedAgent, new Uint8Array(32)), /cannot seal/);
});
