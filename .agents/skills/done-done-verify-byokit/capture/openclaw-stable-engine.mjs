// One explicitly authorized native MiniMax turn; key arrives only by app-passed file path, never environment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenClawKit, ENGINE_VERSION, PluginInstallError } from '@byokit/openclaw';

const [evidence, engineDir, keyPath] = process.argv.slice(2);
assert.ok(evidence && engineDir && keyPath, 'pass evidence directory, disk engine directory and sanctioned key file path');
mkdirSync(evidence, { recursive: true });
const stateDir = mkdtempSync(join(tmpdir(), 'oc933-'));
const apiKey = readFileSync(keyPath, 'utf8').trim();
assert.ok(apiKey.length, 'sanctioned key file is empty');
const run = randomUUID();
const lines = [];
const record = (label, value) => {
  const line = `${label}: ${JSON.stringify(value)}`;
  assert.ok(!line.includes(apiKey), 'credential reached evidence');
  lines.push(line);
  console.log(line);
};
const kit = new OpenClawKit({ stateDir, engineDir, callbackPort: 0, tools: [], offered: ['minimax'] });
try {
  await kit.start();
  assert.equal(kit.state.phase, 'ready');
  assert.equal(kit.hello.server.version, ENGINE_VERSION);
  record('gateway', { run, engine: kit.hello.server.version, phase: kit.state.phase });
  await kit.ensureMember('umer');
  const skills = join(stateDir, 'openclaw/state/agents/umer/agent/workshop-skills/launch-check');
  mkdirSync(skills, { recursive: true });
  const content = '---\nname: launch-check\ndescription: Check the launch for Umer.\n---\nCheck the launch before reporting ready.\n';
  writeFileSync(join(skills, 'SKILL.md'), content);
  assert.ok((await kit.call('skills.proposals.list', { agentId: 'umer' })).installedSkills.some(s => s.name === 'launch-check'));
  assert.equal((await kit.call('skills.workshop.read', { agentId: 'umer', name: 'launch-check' })).content, content);
  await kit.ensureMember('other');
  await assert.rejects(kit.call('skills.workshop.read', { agentId: 'other', name: 'launch-check' }));
  await assert.rejects(kit.installPlugin('telnyx'), e => e instanceof PluginInstallError && e.code === 'unsupported_plugin');
  record('native Workshop', { completeContent: true, otherAgentRefused: true, thirdPartyInstall: 'unsupported_plugin' });
  const catalog = await kit.models('umer', { authChoice: 'minimax-global-api' });
  const flash = catalog.find(m => /m3[.-]1.*flash/i.test(m.id));
  assert.ok(flash, 'booted 9.33 MiniMax catalog has no M3.1 Flash model');
  record('catalog choice', { id: flash.id, name: flash.name });
  const added = await kit.addKey('umer', { authChoice: 'minimax-global-api', apiKey, model: flash.id });
  record('key activation', added); // native setup may make its own verification request, separate from the chat turn
  assert.equal(added.status, 'ok');
  const live = await kit.models('umer', { authChoice: 'minimax-global-api' });
  assert.ok(live.some(m => m.id === flash.id), 'selected id absent from signed-in live catalog');
  record('billing', 'MiniMax API key (billed per use); no claim of a free subscription or zero charge');
  const token = `stable-${run}`;
  const end = await kit.run({ member: 'umer', auth: 'apiKey', sessionKey: `agent:umer:stable:${run}`,
    message: `Reply with exactly ${token} and nothing else.` }, event => {
      if (event.type === 'text') record('reply delta', event.text);
    });
  record('one real chat turn', { ok: end.ok, text: end.text, runId: end.runId });
  assert.equal(end.ok, true);
  assert.ok(end.text.includes(token), 'fresh response marker missing');
  writeFileSync(join(evidence, 'steps.json'), JSON.stringify({ target: { version: `OpenClaw ${ENGINE_VERSION}` },
    start: 'Fresh isolated BYOKit app home; no imported login or environment key.',
    steps: ['Boot the pinned Gateway through the built SDK', 'List/read native agent Workshop skills and refuse another agent',
      'Refuse an unsupported third-party install', 'Activate the sanctioned MiniMax key by path and select the catalog Flash id', 'Send one unique chat turn'],
    result: `Real MiniMax reply returned ${token}; native Workshop reads remain agent-scoped.` }, null, 2));
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
  writeFileSync(join(evidence, 'stable-engine.log'), lines.join('\n') + '\n', { mode: 0o600 });
  for (const name of readdirSync(evidence)) {
    if (name.endsWith('.log') || name.endsWith('.json')) assert.ok(!readFileSync(join(evidence, name), 'utf8').includes(apiKey), 'credential leak');
  }
}
