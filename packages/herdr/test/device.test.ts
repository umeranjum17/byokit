// H7 acceptance (docs/runtime-kits.md 11.3, behavior 7.2) for src/device.ts: envelopes that are not ours open to
// null. Socket behavior lives in test/link.test.ts; bundle portability in test/portable.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxKeyPairFromSeed, openNotice as sealOpenNotice } from '@byokit/seal';
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

// An envelope produced by the pre-delegation code (a fixed byte string, seed all 5s) must still open: the wire
// format is unchanged, and seal's own openNotice opens the same herdr notice with the seed's box secret.
const OLD_ENVELOPE = {
  v: 1,
  sealed: 'tGaPGEeDS2MI_q5Vbe1LOFQ3Wqc0_XpoM4yJfLtpsAFgal-jQa12WVMc6wrBykAxvz2bF-lChTzmZTnjSEVBsCI8czWGFDQbf7oS8tJ6lCHdGuVxssIaybQj9qw_4Rb3UgZYe2PVW7I2afBSmnF4V0iyojF_9S6uoK9HG_eKgfe8G3otkdO3mPS0H7Rzm2V4_5dDiUd3kIhqGOEE56H0l6glumAx156UVIzoBMY7vqoKPpXan0bJUqjE9QSkl1ymofh4dF-LBKvc',
};

test('a notice sealed before the seal delegation still opens', () => {
  const seed = new Uint8Array(32).fill(5);
  assert.deepEqual(openNotice(OLD_ENVELOPE, seed), BLOCKED);
  assert.deepEqual(hdOpen(OLD_ENVELOPE, seed), BLOCKED);
  const secret = boxKeyPairFromSeed(seed).secretKey;
  try { assert.deepEqual(sealOpenNotice(OLD_ENVELOPE, secret), BLOCKED); }
  finally { secret.fill(0); }
  assert.equal(openNotice(OLD_ENVELOPE, new Uint8Array(32).fill(6)), null);
});
