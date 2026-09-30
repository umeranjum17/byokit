import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Reading, Source, Usage } from '../types.ts';
export type UsageContractTestFn = (name: string, fn: (t: { skip(message?: string): void }) => void | Promise<void>) => unknown;
export interface UsageContractBench {
  usage: Usage;
  source: Source;
  expected: Reading['windows'];
  nowMs: number;
  restart(): Usage;
  fake?: { fail(): void; disconnect(): void; calls(): number };
  cleanup?(): void | Promise<void>;
}
export function usageContract(make: () => UsageContractBench | Promise<UsageContractBench>, options: { test?: UsageContractTestFn } | UsageContractTestFn = {}): void {
  const test = typeof options === 'function' ? options : options.test ?? nodeTest;
  test('usage contract: concurrent reads, freshness floor and restart keep one account reading', async () => {
    const b = await make();
    try {
      const [a, duplicate] = await Promise.all([b.usage.read(b.source, { nowMs: b.nowMs }), b.usage.read(b.source, { nowMs: b.nowMs })]);
      assert.deepEqual(a.windows, b.expected); assert.deepEqual(a, duplicate); assert.equal(a.code, undefined);
      const count = b.fake?.calls();
      assert.deepEqual(await b.usage.read(b.source, { nowMs: b.nowMs + 59_999 }), a);
      if (count !== undefined) { assert.equal(count, 1); assert.equal(b.fake!.calls(), count); }
      assert.deepEqual(b.restart().lastKnown(b.source, { nowMs: b.nowMs + 60_000 }), a);
      assert.equal(b.restart().lastKnown(b.source, { nowMs: b.nowMs + 86_400_001 }), undefined);
    } finally { await b.cleanup?.(); }
  });
  test('usage contract: failed reads stand on the last good reading only while connected', async (t) => {
    const b = await make();
    try {
      if (!b.fake) { t.skip('Requires scripted failure and disconnect.'); return; }
      const a = await b.usage.read(b.source, { nowMs: b.nowMs }); b.fake.fail();
      const failed = await b.usage.read(b.source, { nowMs: b.nowMs + 60_000 });
      assert.deepEqual(failed.windows, a.windows); assert.equal(failed.at, a.at); assert.ok(failed.code);
      b.fake.disconnect(); assert.equal(b.usage.connected(b.source), false);
      assert.equal(b.usage.lastKnown(b.source, { nowMs: b.nowMs + 61_000 }), undefined);
      assert.equal((await b.usage.read(b.source, { nowMs: b.nowMs + 61_000 })).code, 'not-connected');
    } finally { await b.cleanup?.(); }
  });
}
