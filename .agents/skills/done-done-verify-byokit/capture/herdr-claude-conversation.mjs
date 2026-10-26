// Real Claude transcript copied into isolated account folders; public built Herdr API only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
const require = createRequire(join(process.cwd(), 'package.json'));
const { HerdrKit, importConversation } = await import(require.resolve('@byokit/herdr'));
const { startFakeHerdr } = await import(require.resolve('@byokit/herdr/testing'));
const source = process.argv[3], root = realpathSync(process.argv[2]);
assert.ok(source && existsSync(source), 'provide an existing Claude session JSONL file');
const id = basename(source, '.jsonl'), project = basename(dirname(source));
assert.match(id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
assert.equal(JSON.parse(readFileSync(source, 'utf8').split('\n', 1)[0]).sessionId, id);
const a = join(root, 'account-a'), b = join(root, 'account-b');
for (const folder of [a, b]) mkdirSync(folder);
const relative = `projects/${project}/${id}.jsonl`, original = join(a, relative);
mkdirSync(dirname(original), { recursive: true }); copyFileSync(source, original);
const fake = await startFakeHerdr({ dir: join(root, 'fake'), world: { kinds: ['claude'] } });
const kit = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: fake.socketPath });
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
try {
  await kit.start();
  const ref = await kit.startAgent({ kind: 'claude', cwd: a, place: { pane: 'w1:p1' }, args: ['--resume', id], installProbe: { path: [] },
    env: { env: { HOME: a, CLAUDE_CONFIG_DIR: a }, unset: [] } });
  fake.world.agents.find(x => x.pane_id === ref.paneId).agent_session = { source: 'fixture', agent: 'claude', kind: 'id', value: id };
  const bundle = join(root, 'bundle'), exported = await kit.exportConversation(ref, { to: bundle });
  assert.equal(exported.ok, true); if (!exported.ok) throw new Error(exported.message);
  const imported = await importConversation({ bundle, accountFolder: b, kind: 'claude', conversation: id });
  assert.deepEqual(imported, exported);
  assert.equal(hash(original), hash(join(b, relative)), 'the earlier transcript was restored byte-for-byte');
  const resumed = await kit.startAgent({ kind: 'claude', cwd: b, place: { pane: 'w1:p2' }, args: ['--resume', id], installProbe: { path: [] },
    env: { env: { HOME: b, CLAUDE_CONFIG_DIR: b }, unset: [] } });
  fake.world.agents.find(x => x.pane_id === resumed.paneId).agent_session = { source: 'fixture', agent: 'claude', kind: 'id', value: id };
  const roundTrip = await kit.exportConversation(resumed, { to: join(root, 'round-trip') });
  assert.equal(roundTrip.ok, true); if (!roundTrip.ok) throw new Error(roundTrip.message);
  assert.equal(roundTrip.conversation, exported.conversation); assert.equal(roundTrip.digest, exported.digest);
  const receipt = { kind: exported.kind, conversation: exported.conversation, files: exported.files, bytes: exported.bytes,
    digest: exported.digest, importDigest: imported.digest, resumeDigest: roundTrip.digest, earlierTurnsRestored: true };
  const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
  assert.ok(evidence, 'done-done supplies its evidence folder');
  writeFileSync(join(evidence, 'conversation.json'), JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(join(evidence, 'steps.json'), JSON.stringify({ target: { version: '0.17.1' }, start: 'real Claude transcript in account A',
    steps: ['copy transcript into isolated account A', 'export portable bundle', 'import into isolated account B', 'resume by the same id and re-export'],
    result: 'Earlier turns restored; conversation id and bundle digest unchanged.' }, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { await kit.stop(); await fake.stop(); }
