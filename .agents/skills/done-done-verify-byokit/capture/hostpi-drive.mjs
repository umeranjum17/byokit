// Capture for the export-a-running-agent / host-owned-Pi-launch change: the built @byokit/herdr
// (dist) against its own fake Herdr transport, no agent CLI and no model session. Writes the
// four-case transcript and steps.json into $DONE_DONE_EVIDENCE_ROOT (done-done run).
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root] = process.argv.slice(2);
const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
if (!root || !evidence) throw new Error('usage: DONE_DONE_EVIDENCE_ROOT=<run folder> node hostpi-drive.mjs <scratch dir>');
const repo = process.cwd();
const { HerdrKit } = await import(join(repo, 'packages/herdr/dist/index.js'));
const { startFakeHerdr } = await import(join(repo, 'packages/herdr/dist/testing/index.js'));
const log = join(evidence, 'hostpi-drive.log');
const version = /"version": "([^"]+)"/.exec(readFileSync(join(repo, 'packages/herdr/package.json'), 'utf8'))[1];
const say = (entry) => {
  const line = JSON.stringify(entry);
  appendFileSync(log, `${line}\n`);
  console.log(line);
};
writeFileSync(log, `# built @byokit/herdr ${version} (packages/herdr/dist) against its own fake Herdr transport\n`);

const a = join(root, 'account-a'), empty = join(root, 'account-empty');
mkdirSync(join(a, 'sessions/--fixture--'), { recursive: true });
mkdirSync(empty, { recursive: true });
const id = '32345678-1234-1234-1234-123456789abc';
const path = `sessions/--fixture--/2026-10-31T00-00-00-000Z_${id}.jsonl`;
writeFileSync(join(a, path), `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-31T00:00:00.000Z', cwd: '/fixture' })}\n`);

const fake = await startFakeHerdr({ dir: join(root, 'fake') });
const kit = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: fake.socketPath });
const reason = (e) => (e && typeof e === 'object' && 'code' in e ? e.code : String(e));
try {
  await kit.start();
  // A pane this kit instance never started: w1:p2 is the fake's own agent, started outside this kit,
  // so only the pane's own Herdr `agent_session` plus the explicit folder can name the conversation.
  const foreign = fake.world.agents.find((x) => x.pane_id === 'w1:p2');
  foreign.agent_session = { source: 'fixture', agent: 'pi', kind: 'path', value: join(a, path) };
  assert.equal(kit.conversationAccounts.has('w1:p2'), false);
  const exported = await kit.exportConversation({ paneId: 'w1:p2' }, { to: join(root, 'bundle'), accountFolder: a });
  say({ case: 'export a pane this kit never started, by explicit folder', export: exported });
  assert.equal(exported.ok, true);
  assert.equal(exported.conversation, id);
  const refused = await kit.exportConversation({ paneId: 'w1:p2' }, { to: join(root, 'wrong'), accountFolder: empty });
  say({ case: 'explicit folder that holds no such conversation', export: refused });
  assert.deepEqual([refused.ok, refused.code], [false, 'unsupported']);
  // Pi's two guards without the opt-in, then a start with neither model nor env under it.
  let model, env;
  try {
    await kit.startAgent({ kind: 'pi', cwd: a, place: { workspace: 'new' }, installProbe: { path: [] },
      env: { env: { HOME: a, PI_CODING_AGENT_DIR: a }, unset: [] } });
  } catch (e) { model = reason(e); }
  say({ case: 'Pi start without the opt-in, no --model', code: model });
  assert.equal(model, 'model_required');
  try {
    await kit.startAgent({ kind: 'pi', cwd: a, place: { workspace: 'new' }, installProbe: { path: [] },
      args: ['--model', 'fixture/offline'] });
  } catch (e) { env = reason(e); }
  say({ case: 'Pi start without the opt-in, no replacement env', code: env });
  assert.equal(env, 'account_required');
  const hosted = await kit.startAgent({ kind: 'pi', cwd: a, place: { workspace: 'new' },
    installProbe: { path: [] }, hostLaunch: true });
  say({ case: 'Pi start with hostLaunch: no --model and no env', ref: hosted });
  assert.equal(typeof hosted.paneId, 'string');
  say({ result: 'explicit-folder export, both Pi refusals and the host opt-in behave as claimed; no agent CLI or model session was started' });
  writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
    target: { version: `@byokit/herdr ${version} (built packages/herdr/dist)` },
    start: 'A fake Herdr transport with one agent pane written outside this kit instance, an isolated Pi session store and no agent CLI or model session',
    steps: [
      'Export a conversation from a pane this kit instance never started, naming its account folder',
      'Ask the same export for a folder that holds no such conversation',
      'Start Pi without the host opt-in, first with no --model and then with no replacement env',
      'Start Pi with hostLaunch: true and neither a model nor an env',
    ],
    result: 'The unstarted pane exports its conversation by the given folder, the wrong folder answers unsupported, Pi refuses model_required and account_required without the opt-in, and starts with it',
  }, null, 2)}\n`);
} finally { await kit.stop(); await fake.stop(); }
