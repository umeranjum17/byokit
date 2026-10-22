// One native chat, no paid activation probe: use the public operator credential setter and agent RPC.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenClawKit, ENGINE_VERSION, PluginInstallError, routes } from '@byokit/openclaw';

const [evidence, engineDir, keyPath] = process.argv.slice(2);
assert.ok(evidence && engineDir && keyPath, 'pass evidence directory, disk engine directory and sanctioned key file path');
mkdirSync(evidence, { recursive: true });
const stateDir = mkdtempSync(join(tmpdir(), 'oc933-'));
const run = randomUUID();
let apiKey = '';
const lines = [];
const record = (label, value) => {
  const line = `${label}: ${JSON.stringify(value)}`;
  assert.ok(!apiKey || !line.includes(apiKey), 'credential reached evidence');
  lines.push(line);
  console.log(line);
};
const kit = new OpenClawKit({ stateDir, engineDir, callbackPort: 0, tools: [], offered: ['minimax'],
  config: { agents: { defaults: { utilityModel: '' } } } });
try {
  await kit.start();
  assert.equal(kit.state.phase, 'ready');
  assert.equal(kit.hello.server.version, ENGINE_VERSION);
  record('gateway', { run, engine: kit.hello.server.version, phase: kit.state.phase });
  await kit.ensureMember('umer');
  const agentDir = join(stateDir, 'openclaw/state/agents/umer/agent');
  const skills = join(agentDir, 'workshop-skills/launch-check');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { provider: { maxRetries: 0 } } }), { mode: 0o600 });
  const content = '---\nname: launch-check\ndescription: Check the launch for Umer.\n---\nCheck the launch before reporting ready.\n';
  writeFileSync(join(skills, 'SKILL.md'), content);
  assert.ok((await kit.call('skills.proposals.list', { agentId: 'umer' })).installedSkills.some(s => s.name === 'launch-check'));
  assert.equal((await kit.call('skills.workshop.read', { agentId: 'umer', name: 'launch-check' })).content, content);
  await kit.ensureMember('other');
  await assert.rejects(kit.call('skills.workshop.read', { agentId: 'other', name: 'launch-check' }));
  await assert.rejects(kit.installPlugin('telnyx'), e => e instanceof PluginInstallError && e.code === 'unsupported_plugin');
  record('native Workshop', { completeContent: true, otherAgentRefused: true, thirdPartyInstall: 'unsupported_plugin' });
  const route = routes().find(r => r.choice === 'minimax-global-api');
  assert.ok(route?.provider, 'the pinned route is missing');
  const catalog = await kit.call('models.list', { agentId: 'umer', view: 'all', refresh: true });
  const flash = catalog.models.find(m => m.provider === route.provider && /m3[.-]1.*flash/i.test(m.id));
  assert.ok(flash, 'booted 9.33 MiniMax catalog has no M3.1 Flash model');
  record('catalog choice', { id: flash.id, name: flash.name, provider: flash.provider });
  apiKey = readFileSync(keyPath, 'utf8').trim();
  assert.ok(apiKey.length, 'sanctioned key file is empty');
  const saved = await kit.call('models.authSetApiKey', { agentId: 'umer', provider: flash.provider, apiKey });
  assert.ok(saved.profileId, 'native credential setter returned no profile');
  assert.ok(!saved.warning, 'native credential update was not applied');
  record('credential stored', { profileId: saved.profileId, verified: false, path: 'public native setter; no activation/probe call' });
  record('billing', 'MiniMax API key (billed per use); no claim of a free subscription or zero charge');
  const token = `stable-${run}`;
  const sessionKey = `agent:umer:stable:${run}`;
  const accepted = await kit.call('agent', { agentId: 'umer', sessionKey, provider: flash.provider, model: flash.id,
    message: `Reply with exactly ${token} and nothing else.`, idempotencyKey: run, promptMode: 'minimal' });
  assert.ok(accepted.runId, 'native chat returned no run id');
  const end = await kit.call('agent.wait', { runId: accepted.runId, timeoutMs: 120_000 }, { timeoutMs: 130_000 });
  assert.equal(end.status, 'ok');
  const history = await kit.call('chat.history', { sessionKey, limit: 10 });
  const reply = history.messages.filter(m => m.role === 'assistant').flatMap(m => typeof m.content === 'string'
    ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text)).join('');
  assert.equal(reply.trim(), token, 'fresh assistant reply marker missing');
  record('one real chat turn', { status: end.status, text: reply, runId: accepted.runId });
  writeFileSync(join(evidence, 'steps.json'), JSON.stringify({ target: { version: `OpenClaw ${ENGINE_VERSION}` },
    start: 'Fresh isolated BYOKit app home; no imported login or environment key.',
    steps: ['Boot the built SDK Gateway', 'Read native agent Workshop instructions and refuse another agent/third-party install',
      'Select the booted catalog Flash id', 'Store the app-passed key through the public native setter without a probe',
      'Send exactly one native chat and read its fresh assistant reply'],
    result: `Real MiniMax reply returned ${token}; this proves public native pass-through, not addKey activation.` }, null, 2));
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
  writeFileSync(join(evidence, 'stable-engine.log'), lines.join('\n') + '\n', { mode: 0o600 });
  for (const name of readdirSync(evidence)) {
    if (apiKey && /\.(log|json)$/.test(name)) assert.ok(!readFileSync(join(evidence, name), 'utf8').includes(apiKey), 'credential leak');
  }
}
