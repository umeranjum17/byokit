// One install, two writers: the Skill Workshop apply path takes a state lease in the shared state database, and
// anything else writing that file (a second process on the same state dir, an engine worker, a CLI left running)
// can hold its write lock while the lease is acquired. A transient SQLITE_BUSY there used to be fatal: the lease
// acquisition reported `store unavailable (sqlite-busy)` the moment its own busy timeout ran out and
// `skills.proposals.apply` failed with "database is locked", losing an apply another writer released a second later.
// This holds the lock past that timeout and expects the apply to land. Real pinned engine, no network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';

const install = scratchDir('o11-engine-sqlite-contention');
const engineDir = sharedEngineDir() ?? join(install, 'engine');
const HOLD_MS = 8_000; // past the engine's 5 s busy timeout, inside what a contended host really waits

before(async () => {
  // Install the pin once; the case reuses it with a fresh state dir (the O6 signin.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
}, { timeout: 600_000 });

test('a proposal apply waits out another writer on the shared state database', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('o-sqlite-contention');
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [] });
  let writer: DatabaseSync | undefined;
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await kit.ensureMember('m1');
    const created = await kit.call('skills.proposals.create', { agentId: 'm1', name: 'Fare Check',
      description: 'How to compare fares across sources', content: '# Fare Check\n\nCheck two sources and say which you checked.\n' }) as { record: { id: string } };
    const proposalId = created.record.id;
    const inspected = await kit.call('skills.proposals.inspect', { agentId: 'm1', proposalId }) as { revisionHash?: string };
    const revisionHash = inspected.revisionHash;
    assert.ok(revisionHash, 'the proposal has a revision hash to apply');

    // The second writer: this process takes a plain write transaction on the shared state database and keeps it
    // while the apply runs. Retried until it wins the lock, because the Gateway writes that file all the time.
    const database = join(stateDir, 'openclaw', 'state', 'state', 'openclaw.sqlite');
    writer = new DatabaseSync(database);
    writer.exec('PRAGMA busy_timeout = 20000');
    for (const until = Date.now() + 60_000; ;) {
      try { writer.exec('BEGIN IMMEDIATE'); break; } catch (error) {
        if (Date.now() > until) throw new Error(`could not take a write transaction on the shared state database: ${(error as Error).message}`);
      }
    }
    writer.exec('CREATE TABLE IF NOT EXISTS byokit_contention_probe (x INTEGER)');
    writer.prepare('INSERT INTO byokit_contention_probe (x) VALUES (1)').run();
    // Held on a timer: the apply below is awaited, so this release lands mid-flight.
    const release = new Promise<void>(resolve => setTimeout(() => {
      writer!.exec('COMMIT');
      resolve();
    }, HOLD_MS));

    const started = Date.now();
    const applied = await kit.call('skills.proposals.apply', { agentId: 'm1', proposalId, expectedRevisionHash: revisionHash }, { timeoutMs: 120_000 }) as { record?: { status?: string }; status?: string };
    const waited = Date.now() - started;
    await release;
    assert.equal(applied.record?.status ?? applied.status, 'applied', 'the proposal is applied once the other writer lets go');
    assert.ok(waited >= HOLD_MS - 1_000, `the apply waited for the other writer instead of failing on its lock (waited ${waited} ms)`);
    const after = await kit.call('skills.proposals.inspect', { agentId: 'm1', proposalId }) as { record: { status: string } };
    assert.equal(after.record.status, 'applied');
  } finally {
    try { if (writer) { if (writer.isTransaction) writer.exec('ROLLBACK'); writer.close(); } } catch { /* the probe writer is disposable */ }
    await kit.stop().catch(() => {});
  }
});
