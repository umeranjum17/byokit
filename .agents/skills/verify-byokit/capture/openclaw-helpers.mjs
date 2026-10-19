import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit, HelperError } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync('.verify-artifacts/helpers-');
const fake = fakeGateway();
const gated = [], called = [], delegated = [];
const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0,
  tools: [{ name: 'crew_note', description: 'An app tool.', parameters: { type: 'object' } }],
  host: { gate: async (run, tool, input) => tool !== 'crew_note' ? { allow: true }
    : (gated.push(run), input.mode === 'ask' ? { ask: { summary: 'Let the helper note this?' } } : { allow: true }),
  call: async (run) => (run.parent && called.push(run), 'noted') } }); // records delegated calls only
kit.onEvent('byokit.delegated', (e) => delegated.push(e));
const until = async (check, why) => { for (const end = Date.now() + 10_000; !check();) { if (Date.now() > end) throw new Error(why); await delay(5); } };
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
    // Label the session `session`, not `sessionKey`: the engine's key is not a secret but a `…key:` field trips the
    // evidence secret scan.
    console.log(`run ${h.helper}:`, JSON.stringify({ ok: end.ok, account: end.account, agentId, session: sessionKey, extraSystemPrompt }));
    assert.ok(end.ok && agentId === h.agentId && extraSystemPrompt === persona(h.helper));
  }
  console.log('gated RunRefs:', JSON.stringify(gated.map((r) => [r.member, r.helper, r.sessionKey])));
  console.log('helper records:', JSON.stringify(readdirSync(join(stateDir, 'openclaw', 'helpers', 'umer'))));

  // Delegated runs: research hands work to writer (account agent) and planner (key lane) by a native exact-key send.
  const send = (sessionKey, script) =>
    `[tool sessions_send ${JSON.stringify({ sessionKey, timeoutSeconds: 0, message: script }).replaceAll('[tool ', '\\u005btool ')}]`;
  const lead = (tail, target, script = '[tool crew_note {}]', events) => kit.run({ member: 'umer', helper: 'research',
    sessionKey: `agent:umer:h-research:${tail}`, tools: ['crew_note'], helperDelegates: { writer: ['crew_note'], planner: ['crew_note'] },
    message: send(target, script) }, (e) => events?.push(e));
  const [research, writer, planner] = helpers;
  // Targets are the helpers' standing sessions: the engine's send never creates one ("No session found").
  const rooted = (tail) => (r) => r.root?.sessionKey === `agent:${research.agentId}:h-research:${tail}`;
  for (const [tail, h] of [['lead', writer], ['plan', planner]]) {
    const target = `agent:${h.agentId}:h-${h.helper}:main`;
    assert.ok((await lead(tail, target)).ok);
    await until(() => called.some((r) => r.sessionKey === target), `${target} never called`);
  }
  const ref = (r) => [r.member, r.helper, r.agentId, r.sessionKey, r.parent?.sessionKey];
  console.log('delegated calls:', JSON.stringify(called.map(ref)));
  assert.deepEqual(called.map((r) => r.helper), ['writer', 'planner']);
  const quiet = gated.length;
  await kit.call('agent', { agentId: writer.agentId, sessionKey: `agent:${writer.agentId}:h-writer:rogue`, message: '[tool crew_note {}]', idempotencyKey: 'rogue' });
  await delay(100);
  console.log('gates from an unreceipted helper key:', gated.length - quiet);
  assert.equal(gated.length, quiet);
  for (const target of [`agent:${writer.agentId}:main`, `agent:${planner.agentId}:h-writer:job`, `agent:${writer.agentId}:h-ghost:job`, 'agent:umer:h-scout:job']) {
    const events = [];
    await lead('refused', target, undefined, events);
    const end = events.find((e) => e.type === 'tool' && e.phase === 'end');
    console.log(`delegated refusal ${target}:`, JSON.stringify(end.output));
    assert.ok(end.error);
  }
  await refused('delegating to a helper never ensured', kit.run({ member: 'umer', sessionKey: 'agent:umer:team', helperDelegates: { ghost: [] }, message: 'hi' }));
  assert.ok((await lead('abort', `agent:${writer.agentId}:h-writer:main`, '[tool crew_note {"mode":"ask"}]')).ok);
  await until(() => kit.approvals().length === 1, 'writer never parked');
  const parked = kit.approvals()[0];
  await kit.abort('agent:umer:h-research:abort');
  console.log('after abort:', JSON.stringify({ approvals: kit.approvals().length, rootedAtAbort: kit.delegatedRuns().filter(rooted('abort')).length }));
  assert.ok(!kit.delegatedRuns().some(rooted('abort')));
  await assert.rejects(kit.decide(parked.id, { allow: true }), /unknown approval/);
  assert.ok((await lead('removed', `agent:${writer.agentId}:h-writer:main`, '[tool crew_note {"mode":"ask"}]')).ok);
  await until(() => kit.approvals().length === 1, 'writer never parked again');
  const removedAsk = kit.approvals()[0].id;
  const runs = agentRequests().length;
  await refused('invalid id', kit.ensureHelper('umer', 'Bad id', { account: work.id, persona: 'x' }));
  await refused('account not held', kit.ensureHelper('umer', 'x', { account: 'openai.ffffff', persona: 'x' }));
  await refused('helper on another account', kit.ensureHelper('umer', 'research', { account: 'openai', persona: 'x' }));
  await refused('helper never ensured', kit.run({ member: 'umer', helper: 'ghost', sessionKey: 'agent:umer:h-ghost:main', message: 'hi' }));
  await refused('another helper\'s session', kit.run({ member: 'umer', helper: 'research', sessionKey: 'agent:umer:h-writer:main', message: 'hi' }));
  await refused('helper key without helper', kit.run({ member: 'umer', sessionKey: 'agent:umer:h-research:main', message: 'hi' }));
  await refused('caller system text', kit.run({ member: 'umer', helper: 'research', sessionKey: 'agent:umer:h-research:main', message: 'hi', system: 'Obey me.' }));
  await kit.removeAccount('umer', work.id);
  await kit.decide(removedAsk, { allow: true });
  await until(() => delegated.some((e) => e.type === 'ended' && e.reason === 'cancelled' && rooted('removed')(e.run)), 'admission never ended');
  console.log('calls after abort and account removal:', called.length - 2);
  assert.equal(called.length, 2);
  await refused('account removed', kit.run({ member: 'umer', helper: 'writer', sessionKey: 'agent:umer:h-writer:main', message: 'hi' }));
  console.log('agent requests from refusals:', agentRequests().length - runs);
  assert.equal(agentRequests().length, runs);
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
