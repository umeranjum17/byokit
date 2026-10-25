// One install, two writers: the public kit applies a Workshop proposal while a second connection holds the shared
// state database's write lock longer than the engine's 5 s SQLite busy timeout. Before the shipped lease-wait edit
// this apply failed with "database is locked"; now it waits for that writer and lands. Real pinned engine, offline.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenClawKit, ENGINE_VERSION } from '@byokit/openclaw';

const HOLD_MS = Number(process.env.BYOKIT_CONTENTION_HOLD_MS ?? 8_000); // past the engine's 5 s busy timeout
const evidence = resolve(process.argv[2] ?? process.env.DONE_DONE_EVIDENCE_ROOT ?? '.');
// A task-owned disk directory, never tmpfs: the pinned engine is a few hundred MB and installs once.
const engineDir = process.env.BYOKIT_VERIFY_ENGINE_DIR ?? join(homedir(), '.cache', 'byokit-done-done-engine');
mkdirSync(evidence, { recursive: true });
const stateDir = mkdtempSync(join(tmpdir(), 'oc-contention-'));
const lines = [];
const record = (label, value) => {
  const line = `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  lines.push(line);
  console.log(line);
  return value;
};
const kit = new OpenClawKit({ stateDir, engineDir, callbackPort: 0, tools: [] });
let writer;
try {
  await kit.start();
  assert.equal(kit.state.phase, 'ready');
  record('gateway', { engine: kit.hello?.server?.version ?? ENGINE_VERSION, phase: kit.state.phase, patchSet: kit.state.patchSet ?? null });
  await kit.ensureMember('umer');
  const created = await kit.call('skills.proposals.create', { agentId: 'umer', name: 'Fare Check',
    description: 'How to compare fares across sources', content: '# Fare Check\n\nCheck two sources and say which you checked.\n' });
  const proposalId = created.record.id;
  const inspected = await kit.call('skills.proposals.inspect', { agentId: 'umer', proposalId });
  const revisionHash = inspected.revisionHash;
  assert.ok(revisionHash, 'the proposal has no revision hash');
  record('proposal', { id: proposalId, status: inspected.record.status, revisionHash: revisionHash.slice(0, 16) });

  // The second writer: a plain write transaction on the same state database, held while the apply runs.
  const database = join(stateDir, 'openclaw', 'state', 'state', 'openclaw.sqlite');
  writer = new DatabaseSync(database);
  writer.exec('PRAGMA busy_timeout = 20000');
  for (const until = Date.now() + 60_000; ;) {
    try { writer.exec('BEGIN IMMEDIATE'); break; } catch (error) {
      if (Date.now() > until) throw new Error(`could not take the state database's write lock: ${error.message}`);
    }
  }
  writer.exec('CREATE TABLE IF NOT EXISTS byokit_contention_probe (x INTEGER)');
  writer.prepare('INSERT INTO byokit_contention_probe (x) VALUES (1)').run();
  record('second writer', { transaction: 'BEGIN IMMEDIATE', holdsMs: HOLD_MS, journalMode: writer.prepare('PRAGMA journal_mode').get().journal_mode });
  const release = new Promise(done => setTimeout(() => { writer.exec('COMMIT'); done(); }, HOLD_MS));

  const started = Date.now();
  const applied = await kit.call('skills.proposals.apply', { agentId: 'umer', proposalId, expectedRevisionHash: revisionHash }, { timeoutMs: 120_000 });
  const waited = Date.now() - started;
  await release;
  assert.equal(applied.record?.status ?? applied.status, 'applied', 'the proposal did not apply');
  assert.ok(waited >= HOLD_MS - 1_000, `the apply did not wait for the other writer (${waited} ms)`);
  record('apply', { status: 'applied', waitedMs: waited, failedError: null });
  const after = await kit.call('skills.proposals.inspect', { agentId: 'umer', proposalId });
  assert.equal(after.record.status, 'applied');
  record('after', { status: after.record.status, waitedPastBusyTimeout: true });
  writeFileSync(join(evidence, 'workshop-contention.log'), `${lines.join('\n')}\n`);
  writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
    target: { version: `OpenClaw ${ENGINE_VERSION}` },
    start: 'a fresh isolated engine state directory, one member, one pending Workshop proposal',
    steps: [
      'Boot the pinned Gateway through the public kit and create and inspect a Workshop proposal for a member',
      `Take the shared state database's write lock from a second connection and hold it ${HOLD_MS / 1000} s`,
      'Apply the proposal through skills.proposals.apply while that lock is held'
    ],
    result: 'the apply waits for the other writer and lands applied, with the proposal reading applied afterwards'
  }, null, 2)}\n`);
  console.log('WORKSHOP-CONTENTION OK');
} finally {
  try { if (writer) { if (writer.isTransaction) writer.exec('ROLLBACK'); writer.close(); } } catch { /* the probe writer is disposable */ }
  await kit.stop().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}
