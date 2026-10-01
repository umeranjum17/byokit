import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessLog, HarnessLogError, callLedger, memoryTokenLedgerStore, tokenLedger, type HarnessLogPage } from '@byokit/usage';

const stamp = '2026-10-01T12:00:00.000Z';
const time = Date.parse(stamp);
const line = (value: unknown) => JSON.stringify(value) + '\n';
const claude = (id: string) => line({ type: 'assistant', timestamp: stamp, requestId: 'request-' + id,
  message: { id, role: 'assistant', model: 'fixture-model', content: 'SECRET-PROMPT',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } } });
const pi = (id: string) => line({ type: 'message', id, timestamp: stamp,
  message: { role: 'assistant', model: 'fixture-model', provider: 'fixture-provider',
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 5 } } });

// Built public export, actual filesystem fixtures, normalized ledger integration.
test('explicit log source pages append-only supported entries without rescanning or leaking transcript data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-log-'));
  try {
    const path = join(root, 'claude.jsonl');
    const fork = join(root, 'fork.jsonl');
    const p = join(root, 'pi.jsonl');
    const omp = join(root, 'omp.jsonl');
    const codex = join(root, 'codex.jsonl');
    const context = line({ type: 'session_meta', payload: { model_provider: 'recorded-provider' } })
      + line({ type: 'turn_context', payload: { model: 'recorded-model' } });
    const event = (total: number, timestamp = stamp) => line({ type: 'event_msg', timestamp,
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: 45, cached_input_tokens: 30, output_tokens: 20, total_tokens: 65 } } } });
    writeFileSync(path, claude('a') + claude('a') + '{invalid SECRET-TOKEN}\n' + line(null)
      + line({ message: { role: 'user', usage: { input_tokens: 999 }, content: 'SECRET-USER' } }));
    writeFileSync(fork, claude('a'));
    writeFileSync(p, pi('pi-a') + pi('pi-a'));
    writeFileSync(omp, pi('omp-a'));
    // A malformed observation must not move Codex's cumulative watermark.
    writeFileSync(codex, context + event(100, 'invalid') + event(100) + event(100));
    const source = harnessLog({ files: [ { path, format: 'claude' }, { path: fork, format: 'claude' },
      { path: p, format: 'pi' }, { path: omp, format: 'omp' }, { path: codex, format: 'codex' } ] });
    const entries: HarnessLogPage['entries'] = [];
    const pages: HarnessLogPage[] = [];
    for (let i = 0; i < 200; i++) {
      const page = await source.read({ maxBytes: 79, maxLines: 2, maxEntries: 1, deadlineMs: 10000 });
      pages.push(page); entries.push(...page.entries);
      assert.equal(page.code, undefined);
      assert.ok(page.work.bytesRead <= 79 && page.work.lines <= 2 && page.entries.length <= 1);
      if (!page.more) break;
      assert.ok(i < 199, 'bounded pages eventually drain');
    }
    assert.equal(entries.length, 4);
    assert.equal(entries[3].provider, 'recorded-provider');
    assert.equal(entries[3].model, 'recorded-model');
    assert.ok(pages.reduce((n, page) => n + page.work.malformed, 0) >= 3);
    assert.ok(pages.reduce((n, page) => n + page.work.duplicates, 0) >= 3);
    const unchanged = await source.read();
    assert.equal(unchanged.entries.length, 0);
    assert.equal(unchanged.work.bytesRead, 0); assert.equal(unchanged.work.parserCalls, 0);
    const next = claude('b');
    appendFileSync(path, next.slice(0, 100));
    const partial = await source.read();
    assert.equal(partial.entries.length, 0); assert.equal(partial.work.bytesRead, 100);
    const stillPartial = await source.read();
    assert.equal(stillPartial.work.bytesRead, 0); assert.equal(stillPartial.work.parserCalls, 0);
    appendFileSync(path, next.slice(100));
    const append = await source.read(); entries.push(...append.entries);
    assert.equal(append.entries.length, 1); assert.equal(append.work.bytesRead, Buffer.byteLength(next) - 100);
    assert.equal(append.work.parserCalls, 1);
    // Replacement identity resets context/cursor, retains dedupe across copies.
    renameSync(path, join(root, 'old.jsonl')); writeFileSync(path, claude('a') + claude('c'));
    const rotation = await source.read(); entries.push(...rotation.entries);
    assert.equal(rotation.work.resets, 1); assert.equal(rotation.entries.length, 1);
    writeFileSync(path, claude('d'));
    const truncated = await source.read(); entries.push(...truncated.entries);
    assert.equal(truncated.work.resets, 1); assert.equal(truncated.entries.length, 1);
    // A shrink can stay above a partially drained cursor; it still starts a new stream.
    const shrinking = join(root, 'shrinking.jsonl'); writeFileSync(shrinking, claude('old-one') + claude('old-two'));
    const partialSource = harnessLog({ files: [{ path: shrinking, format: 'claude' }] });
    assert.equal((await partialSource.read({ maxBytes: 20 })).entries.length, 0);
    writeFileSync(shrinking, claude('new-one'));
    const resetPartial = await partialSource.read();
    assert.equal(resetPartial.work.resets, 1); assert.equal(resetPartial.entries.length, 1);
    assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
    assert.ok(!JSON.stringify({ pages, entries }).includes('SECRET'));
    const store = memoryTokenLedgerStore(); const calls = callLedger({ store });
    for (const entry of entries) calls.record('host-member', {
      provider: entry.provider ?? 'host-selected-provider', model: entry.model!, account: 'host-account',
      runId: 'host-run', lane: 'host-lane', route: 'host-route', billing: 'subscription', time: entry.time, usage: entry.usage,
    });
    assert.equal(calls.queryRun('host-member', 'host-run', time, time + 1).tokens.total, 7 * 65);
    assert.equal(tokenLedger({ store }).query('host-member', time, time + 1).tokens, 7 * 65);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('log source bounds long lines, retained identities, cancellation and file isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-log-'));
  try {
    const path = join(root, 'source.jsonl');
    writeFileSync(path, 'SECRET'.repeat(100) + '\n' + claude('a') + claude('b'));
    const source = harnessLog({ files: [{ path, format: 'claude' }], maxLineBytes: 500, maxIdentities: 1 });
    const abort = new AbortController(); abort.abort('SECRET');
    const cancelled = await source.read({ signal: abort.signal });
    assert.equal(cancelled.code, 'cancelled'); assert.equal(cancelled.work.bytesRead, 0);
    const first = await source.read();
    assert.equal(first.work.oversized, 1); assert.equal(first.entries.length, 1); assert.equal(first.code, 'capacity');
    const held = await source.read();
    assert.equal(held.code, 'capacity'); assert.equal(held.entries.length, 0); assert.equal(held.work.bytesRead, 0);
    assert.ok(!JSON.stringify([cancelled, first, held]).includes('SECRET'));
    const alias = join(root, 'alias.jsonl'); symlinkSync(path, alias);
    const denied = await harnessLog({ files: [{ path: alias, format: 'claude' }] }).read();
    assert.equal(denied.code, 'unavailable'); assert.equal(denied.work.bytesRead, 0);
    mkdirSync(join(root, 'directory'));
    assert.equal((await harnessLog({ files: [{ path: join(root, 'directory'), format: 'pi' }] }).read()).code, 'unavailable');
    assert.throws(() => harnessLog({ files: [{ path: 'relative', format: 'claude' }] }), HarnessLogError);
    assert.throws(() => harnessLog({ files: [{ path, format: 'unverified' as 'claude' }] }), HarnessLogError);
    const active = new AbortController();
    const fresh = harnessLog({ files: [{ path, format: 'claude' }] });
    const reading = fresh.read({ signal: active.signal });
    assert.equal((await fresh.read()).code, 'busy'); active.abort();
    assert.equal((await reading).code, 'cancelled');
    assert.equal((await fresh.read()).entries.length, 2);
    // A genuine short deadline across bounded explicit fixtures; no generated load.
    const files = Array.from({ length: 32 }, (_, i) => {
      const path = join(root, `deadline-${i}.jsonl`); writeFileSync(path, claude(`deadline-${i}`)); return { path, format: 'claude' as const };
    });
    const timed = harnessLog({ files });
    const timedPage = await timed.read({ deadlineMs: 1 });
    assert.equal(timedPage.code, 'deadline');
    const resumed = await timed.read({ deadlineMs: 10000 });
    assert.equal(timedPage.entries.length + resumed.entries.length, 32);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
