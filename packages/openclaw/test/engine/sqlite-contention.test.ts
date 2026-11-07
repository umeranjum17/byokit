// One install, two writers: creating an agent takes a state lease in the shared state database, and anything else
// writing that file (a second process on the same state dir, an engine worker, a CLI left running) can hold its write
// lock while the lease is acquired. A transient SQLITE_BUSY there used to be fatal: the lease acquisition reported
// `store unavailable (sqlite-busy)` the moment its own busy timeout ran out and the call failed with "database is
// locked", losing work another writer released a second later. 11.1 retired the proposal apply this first guarded, so
// the proof holds the lock past that timeout across a lease-taking create. Real pinned engine, no network.
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

test('a lease-taking agent create waits out another writer on the shared state database', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('o-sqlite-contention');
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [] });
  let writer: DatabaseSync | undefined;
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await kit.ensureMember('m1');
    // The second writer: this process takes a plain write transaction on the shared state database and keeps it
    // while the create runs. Retried until it wins the lock, because the Gateway writes that file all the time.
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
    // Held on a timer: the create below is awaited, so this release lands mid-flight.
    const release = new Promise<void>(resolve => setTimeout(() => {
      writer!.exec('COMMIT');
      resolve();
    }, HOLD_MS));

    const started = Date.now();
    const created = await kit.call('agents.create', { name: 'm2', workspace: join(stateDir, 'openclaw', 'workspaces', 'm2') }, { timeoutMs: 120_000 }) as { agentId?: string };
    const waited = Date.now() - started;
    await release;
    assert.equal(created.agentId, 'm2', 'the agent is created once the other writer lets go');
    assert.ok(waited >= HOLD_MS - 1_000, `the create waited for the other writer instead of failing on its lock (waited ${waited} ms)`);
    const listed = await kit.call('agents.list', {}) as { agents: { id: string }[] };
    assert.ok(listed.agents.some(agent => agent.id === 'm2'));
  } finally {
    try { if (writer) { if (writer.isTransaction) writer.exec('ROLLBACK'); writer.close(); } } catch { /* the probe writer is disposable */ }
    await kit.stop().catch(() => {});
  }
});
