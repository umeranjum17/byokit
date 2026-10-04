import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { scratchDir, removeScratch } from '../../test-support.ts';
import { appendUsageBoot } from '../src/usage-boots.ts';
test('boot records use one 0600 append, single write and fsync before returning', t => {
  const dir = scratchDir('usage-boot'), operations: string[] = [];
  const open = fs.openSync, write = fs.writeSync, sync = fs.fsyncSync;
  try {
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { operations.push('open'); assert.equal(args[1], 'a'); assert.equal(args[2], 0o600); return open(...args); });
    t.mock.method(fs, 'writeSync', (...args: any[]) => { operations.push('write'); return (write as any)(...args); });
    t.mock.method(fs, 'fsyncSync', (...args: Parameters<typeof fs.fsyncSync>) => { operations.push('sync'); return sync(...args); });
    syncBuiltinESMExports();
    appendUsageBoot(dir, { bootId: 'launch-uuid', startedAt: 100 });
    assert.deepEqual(operations, ['open', 'write', 'sync']);
    assert.equal(fs.statSync(join(dir, 'boots.jsonl')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(join(dir, 'boots.jsonl'), 'utf8'), '{"bootId":"launch-uuid","startedAt":100}\n');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); removeScratch(dir); }
});
test('open, short-write and fsync failures reject without disclosing the underlying error', t => {
  const dir = scratchDir('usage-boot-failure');
  try {
    for (const method of ['openSync', 'writeSync', 'fsyncSync'] as const) {
      t.mock.method(fs, method, () => { if (method === 'writeSync') return 1; throw new Error('PRIVATE_SECRET_CANARY'); });
      syncBuiltinESMExports();
      assert.throws(() => appendUsageBoot(dir, { bootId: 'launch-uuid', startedAt: 100 }), /^Error: Usage boot record could not be made durable$/);
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); removeScratch(dir); }
});
