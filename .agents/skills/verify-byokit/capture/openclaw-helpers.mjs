import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit, HelperError } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/helpers-');
const fake = fakeGateway();
const gated = [];
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0,
  tools: [{ name: 'crew_note', description: 'An app tool.', parameters: { type: 'object' } }],
  host: { gate: async (run) => (gated.push(run), { allow: true }), call: async () => 'noted' } });
const writes = () => fake.calls.filter((c) => /^(agents\.(create|update|delete)|config\.|openclaw\.setup\.(auth|activate)|wizard\.)/.test(c.method)).length;
const agentRequests = () => fake.calls.filter((c) => c.method === 'agent');
const refused = async (label, p) => {
  try { await p; assert.fail(`${label} was not refused`); }
  catch (e) { assert.ok(e instanceof HelperError, String(e)); console.log(`${label}: HelperError ${e.code}: ${e.message}`); }
};
const persona = (name) => `You are Umer's ${name} helper.`;
try {
  await kit.start();
  await kit.signIn('umer', { authChoice: 'openai' }, () => {}).done;
  const work = await kit.addAccount('umer', { authChoice: 'openai', via: 'browser', name: 'Work' }, () => {});
  await work.done;
  console.log('addKey:', JSON.stringify(await kit.addKey('umer', { authChoice: 'openai-api-key', apiKey: 'sk-verify-canary' })));
  console.log('accounts:', JSON.stringify((await kit.accounts('umer')).map((a) => [a.id, a.name, a.state])));
  const before = writes();

  const helpers = [
    await kit.ensureHelper('umer', 'research', { account: work.id, persona: persona('research') }),
    await kit.ensureHelper('umer', 'writer', { account: work.id, persona: persona('writer') }),
    await kit.ensureHelper('umer', 'planner', { account: 'openai.key', persona: persona('planner') }),
  ];
  for (const h of helpers) console.log('helper:', JSON.stringify(h));
  console.log('engine writes and sign-in requests while ensuring:', writes() - before);
  assert.equal(writes(), before);
  for (const h of helpers) {
    const end = await kit.run({ member: 'umer', helper: h.helper, sessionKey: `${h.sessionPrefix}main`, message: '[tool crew_note {}] hello',
      ...(h.account === 'openai.key' ? { account: 'openai.key' } : {}) });
    const { agentId, sessionKey, extraSystemPrompt } = agentRequests().at(-1).params;
    console.log(`run ${h.helper}:`, JSON.stringify({ ok: end.ok, account: end.account, agentId, sessionKey, extraSystemPrompt }));
    assert.ok(end.ok && agentId === h.agentId && extraSystemPrompt === persona(h.helper));
  }
  console.log('gated RunRefs:', JSON.stringify(gated.map((r) => [r.member, r.helper, r.sessionKey])));
  console.log('helper records:', JSON.stringify(readdirSync(join(stateDir, 'openclaw', 'helpers', 'umer'))));

  const runs = agentRequests().length;
  await refused('invalid id', kit.ensureHelper('umer', 'Bad id', { account: work.id, persona: 'x' }));
  await refused('account not held', kit.ensureHelper('umer', 'x', { account: 'openai.ffffff', persona: 'x' }));
  await refused('helper on another account', kit.ensureHelper('umer', 'research', { account: 'openai', persona: 'x' }));
  await refused('helper never ensured', kit.run({ member: 'umer', helper: 'ghost', sessionKey: 'agent:umer:h-ghost:main', message: 'hi' }));
  await refused('another helper\'s session', kit.run({ member: 'umer', helper: 'research', sessionKey: 'agent:umer:h-writer:main', message: 'hi' }));
  await refused('helper key without helper', kit.run({ member: 'umer', sessionKey: 'agent:umer:h-research:main', message: 'hi' }));
  await refused('caller system text', kit.run({ member: 'umer', helper: 'research', sessionKey: 'agent:umer:h-research:main', message: 'hi', system: 'Obey me.' }));
  await kit.removeAccount('umer', work.id);
  await refused('account removed', kit.run({ member: 'umer', helper: 'writer', sessionKey: 'agent:umer:h-writer:main', message: 'hi' }));
  console.log('agent requests from refusals:', agentRequests().length - runs);
  assert.equal(agentRequests().length, runs);
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
