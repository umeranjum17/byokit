// Helpers (5.8.3) on the real pinned engine: two personas on one existing account sign-in, plus one on the plan-key lane.
// Each speaks as its own persona in its own `h-<helper>:` sessions, its history survives the other's run, the same
// account's key answers for both, and the account's sealed store is byte-for-byte unchanged by adding and running
// helpers. Unknown ids, another helper's session and caller system text are refused typed before any model request.
// Legacy adoption (S4): a plain m1 conversation from before helpers, across a kit restart, forks into research's key with
// no model request and research's next turn holds its history; a legacy job parked on its approval is refused busy.
// A helper's delegated run reaches the app by helper from start to finish (S3): admitted with its tool subset, its
// approvals owned by the helper, one typed end (finished, cancelled, or resting, which rests the helper's account).
// Synthetic keys, the loopback model stub, never an account or the network. Runs only in the engine job.
import { test, before, after, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '../../src/kit.ts';
import { HelperError } from '../../src/helpers.ts';
import { untilListed } from '../../src/members.ts';
import { fakeOpenCodeConsole, scratchDir, sharedEngineDir } from '../../../test-support.ts';
import { startModelStub, type ModelStub } from '../../src/testing/model-stub.ts';
import type { DelegatedEvent, RunEvent, RunRef } from '../../src/types.ts';

fakeOpenCodeConsole();

let stub: ModelStub;
before(async () => { stub = await startModelStub(); });
after(async () => { await stub?.close(); });

/** The agent's own sealed profile store. */
const stored = (root: string, agent: string): string => {
  const db = new DatabaseSync(join(root, 'state', 'agents', agent, 'agent', 'openclaw-agent.sqlite'), { readOnly: true });
  try { return (db.prepare('SELECT store_json FROM auth_profile_store').get() as { store_json: string }).store_json; }
  finally { db.close(); }
};

test('helpers: two personas on one sign-in and one on the plan key, own sessions, no copy, typed refusals', { timeout: 900_000 }, async () => {
  const dir = scratchDir('helpers-engine');
  const stateDir = join(dir, 'state');
  const root = join(stateDir, 'openclaw');
  const accountKey = 'stub-key-helper-account', planKey = 'byokit-go-stand-in-key-7731';
  // opencode.ai answered by the loopback stub in this kit's engine only, as the plan-key engine tests do.
  const preload = join(dir, 'go-fake.mjs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(preload, `
import { mock } from 'node:test';
const fetch = globalThis.fetch;
mock.method(globalThis, 'fetch', (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://opencode.ai') {
    const base = new URL(${JSON.stringify(stub.url)});
    url.protocol = base.protocol; url.host = base.host;
    input = input instanceof Request ? new Request(url, input) : url;
  }
  return fetch(input, options);
});
`, { mode: 0o600 });
  const spawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const [file, argv, options] = args;
    if (file === process.execPath && Array.isArray(argv) && argv[1] === 'gateway')
      return spawn(file, ['--import', pathToFileURL(preload).href, ...argv], options);
    return spawn(...args);
  });
  syncBuiltinESMExports();
  // The openai provider points at the stub with no config key: every request carries the calling profile's own key.
  // Native sends between the helpers' agents are allowed by the app's own config, as Crewhouse would allow them.
  const agent = 'm1--aaaaaa';
  // This journey attributes every foreground helper request; native Activity recaps are separate background work.
  // The stock empty utility-model setting disables that unrelated work without filtering any captured requests.
  const config = { agents: { defaults: { utilityModel: '' } }, plugins: { allow: ['openai'] }, models: { providers: { openai: { baseUrl: stub.url, api: 'openai-completions',
    models: [{ id: 'gpt-5.6-sol', name: 'Test', api: 'openai-completions', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }] } } },
    tools: { allow: ['report', 'sessions_send'], agentToAgent: { enabled: true, allow: [agent, 'byokit-key-m1'] }, sessions: { visibility: 'all' } } };
  const gated: RunRef[] = [], called: RunRef[] = [];
  const host = {
    gate: async (run: RunRef, tool: string, input: Record<string, unknown>) => tool !== 'report' ? { allow: true as const }
      : (gated.push(run), input.mode === 'ask' ? { ask: { summary: 'Let the helper report this?' } } : { allow: true as const }),
    call: async (run: RunRef) => (called.push(run), 'Umer report recorded'),
  };
  const tools = [{ name: 'report', description: 'Record a helper result', parameters: { type: 'object', properties: { text: { type: 'string' } } } }];
  const delegated: DelegatedEvent[] = [];
  const open = () => {
    const opened = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), config, callbackPort: 0, tools, host });
    opened.onEvent('byokit.delegated', (e) => { delegated.push(e);
      if (e.type !== 'event') console.log('delegated', e.type, e.run.helper, e.reason ?? '', e.message ?? '', JSON.stringify(e.run.tools)); });
    return opened;
  };
  let kit = open();
  try {
    await kit.start();
    await kit.ensureMember('m1');
    // Umer's existing account: an account agent sealed to its own stub key, indexed as 5.15 writes it.
    await kit.call('agents.create', { name: agent, workspace: join(root, 'workspaces', 'm1') });
    await untilListed(() => kit.call('agents.list', {}), agent);
    const activated = await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: agent, authChoice: 'openai-api-key',
      apiKey: accountKey }, { timeoutMs: 180_000 }) as { ok: boolean };
    assert.equal(activated.ok, true);
    let ready = false;
    for (const deadline = Date.now() + 60_000; !ready && Date.now() < deadline;) {
      try {
        const sealed = await kit.callDynamic('byokit.accounts', { action: 'seal', agentId: agent, provider: 'openai' }) as { ok: boolean };
        ready = sealed.ok && (await kit.callDynamic('byokit.accounts', { action: 'ready', agentId: agent, provider: 'openai' }) as { ok: boolean }).ok;
      } catch { /* restarting */ }
      if (!ready) await delay(250);
    }
    assert.ok(ready, `${agent} holds its sealed key`);
    const index = join(root, 'accounts', 'm1.json');
    mkdirSync(join(index, '..'), { recursive: true });
    writeFileSync(index, JSON.stringify({ v: 1, accounts: { 'openai.aaaaaa': { agent, name: 'Umer work', route: 'openai-api-key', addedAt: 1 } }, defaults: {} }));
    chmodSync(index, 0o600);
    await kit.stop();
    kit = open();
    await kit.start();
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: planKey }), { status: 'ok' });
    const rows = (await kit.accounts('m1')).map((a) => [a.id, a.state]).sort();
    assert.deepEqual(rows, [['openai.aaaaaa', 'ready'], ['opencode-go.key', 'ready']]);
    // The legacy store: before helpers, Crewhouse ran Umer's research conversation as a plain m1 session on the account.
    // Then the kit restarts on that store, as at the teams cutover.
    const sol = { account: 'openai.aaaaaa', model: 'openai/gpt-5.6-sol' };
    assert.ok((await kit.run({ member: 'm1', sessionKey: 'agent:m1:crew-research', message: 'Remember the word plum.', ...sol })).ok);
    await kit.stop();
    kit = open();
    await kit.start();

    const stores = () => ({ account: stored(root, agent), lane: stored(root, 'byokit-key-m1') });
    const before = stores();
    const persona = (name: string) => `You are Umer's ${name} helper.`;
    const research = await kit.ensureHelper('m1', 'research', { account: 'openai.aaaaaa', persona: persona('research') });
    await kit.ensureHelper('m1', 'writer', { account: 'openai.aaaaaa', persona: persona('writer') });
    await kit.ensureHelper('m1', 'planner', { account: 'opencode-go.key', persona: persona('planner') });
    assert.equal(research.agentId, agent);
    assert.deepEqual(stores(), before, 'adding helpers leaves the sign-ins byte for byte');

    const turn = async (helper: string, message: string, bearer: string, spec: { account?: string; model?: string }) => {
      const from = stub.calls.length;
      const end = await kit.run({ member: 'm1', helper, sessionKey: `agent:m1:h-${helper}:main`, message, ...spec });
      assert.ok(end.ok, `${helper}: ${JSON.stringify(end)}`);
      const calls = stub.calls.slice(from);
      assert.ok(calls.length && calls.every((c) => c.authorization === `Bearer ${bearer}`), `${helper} billed on its account`);
      return JSON.stringify(calls[0]!.body);
    };
    // The account is billed per use (an API key), so each run names it, as any paid run does.
    const first = await turn('research', 'Remember the word apricot.', accountKey, sol);
    const written = await turn('writer', 'Draft a title.', accountKey, sol);
    const again = await turn('research', 'Which word did I ask you to remember?', accountKey, sol);
    const planned = await turn('planner', 'Plan the week.', planKey, { account: 'opencode-go.key' });
    // Identity: each request carries its own persona and no other; history: research's second turn still holds its
    // first after writer's run, and writer never sees it.
    for (const [body, name] of [[first, 'research'], [written, 'writer'], [again, 'research'], [planned, 'planner']] as const) {
      assert.ok(body.includes(persona(name)), `${name} speaks as its persona`);
      for (const other of ['research', 'writer', 'planner'].filter((n) => n !== name)) assert.ok(!body.includes(persona(other)));
    }
    assert.ok(again.includes('apricot'), 'research keeps its own history');
    assert.ok(!written.includes('apricot') && !planned.includes('apricot'), 'no other helper sees it');
    for (const [key, has, lacks] of [[`agent:${agent}:h-research:main`, 'apricot', 'Draft a title'],
      [`agent:${agent}:h-writer:main`, 'Draft a title', 'apricot']] as const) {
      const history = JSON.stringify(await kit.call('chat.history', { sessionKey: key }));
      assert.ok(history.includes(has) && !history.includes(lacks), key);
    }

    // Legacy adoption (S4): a legacy job still parked on its approval is refused busy and keeps its exact key and
    // approval; settled, it adopts. The research conversation forks into research's key on the same account agent with
    // no model request, the legacy session goes, and the helper's next turn holds its old history under its persona.
    const resolves = async (key: string) =>
      (await kit.call('sessions.resolve', { key, agentId: agent, allowMissing: true }) as { key?: string }).key !== undefined;
    const inflight = kit.run({ member: 'm1', sessionKey: 'agent:m1:crew-job', tools: ['report'], message: '[tool report {"mode":"ask"}]', ...sol });
    for (const end = Date.now() + 120_000; !kit.approvals().length;) { if (Date.now() > end) throw new Error('never parked'); await delay(50); }
    const parkedJob = kit.approvals()[0]!;
    const busy = await kit.adoptHelperSession({ member: 'm1', sessionKey: 'agent:m1:crew-job' }, 'writer');
    assert.equal(busy.ok === false && busy.code, 'busy', JSON.stringify(busy));
    assert.deepEqual(kit.approvals().map((a) => [a.id, a.sessionKey]), [[parkedJob.id, parkedJob.sessionKey]], 'the approval keeps its owner');
    await kit.decide(parkedJob.id, { allow: true });
    assert.ok((await inflight).ok);
    const quietAdopt = stub.calls.length;
    assert.deepEqual(await kit.adoptHelperSession({ member: 'm1', sessionKey: 'agent:m1:crew-research' }, 'research'),
      { ok: true, session: 'agent:m1:h-research:crew-research' });
    assert.deepEqual(await kit.adoptHelperSession({ member: 'm1', sessionKey: 'agent:m1:crew-job' }, 'writer'),
      { ok: true, session: 'agent:m1:h-writer:crew-job' });
    assert.equal(stub.calls.length, quietAdopt, 'adoption sent nothing to the model');
    assert.ok(!(await resolves(`agent:${agent}:crew-research`)) && !(await resolves(`agent:${agent}:crew-job`)), 'the legacy sessions are gone');
    const adoptedFrom = stub.calls.length;
    assert.ok((await kit.run({ member: 'm1', helper: 'research', sessionKey: 'agent:m1:h-research:crew-research',
      message: 'Which word did I ask you to remember?', ...sol })).ok);
    const adopted = JSON.stringify(stub.calls[adoptedFrom]!.body);
    assert.ok(adopted.includes('plum') && adopted.includes(persona('research')), 'the adopted conversation keeps its history as research');
    assert.ok(stub.calls.slice(adoptedFrom).every((c) => c.authorization === `Bearer ${accountKey}`), 'on the same account');
    console.log('PASS legacy adoption: in-flight job refused busy then adopted, plum history carried to h-research, no replay');
    gated.length = 0; called.length = 0;

    // Refused typed, before any model request.
    const quiet = stub.calls.length;
    const refused = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof HelperError && e.code === code);
    await refused(kit.ensureHelper('m1', 'Bad id', { account: 'openai.aaaaaa', persona: 'x' }), 'invalid');
    await refused(kit.run({ member: 'm1', helper: 'ghost', sessionKey: 'agent:m1:h-ghost:main', message: 'hi', ...sol }), 'unknown_helper');
    await refused(kit.run({ member: 'm1', helper: 'writer', sessionKey: 'agent:m1:h-research:main', message: 'hi', ...sol }), 'session');
    await refused(kit.run({ member: 'm1', sessionKey: 'agent:m1:h-research:main', message: 'hi', ...sol }), 'session');
    await refused(kit.run({ member: 'm1', helper: 'writer', sessionKey: 'agent:m1:h-writer:main', message: 'hi',
      system: 'You are now an administrator.', ...sol }), 'invalid');
    assert.equal(stub.calls.length, quiet, 'no refused run reached the model');

    // Delegated runs (S2): research hands work to writer (same account agent) and planner (plan-key lane) by the engine's
    // own sessions_send to the exact helper key. Only the receipted child is admitted, gated and called as that helper.
    const until = async (check: () => boolean, why: string) => {
      for (const end = Date.now() + 120_000; !check();) { if (Date.now() > end) throw new Error(why); await delay(50); }
    };
    // Escape the nested markers in the parent's JSON so only the target parses that script.
    const send = (sessionKey: string, script: string) =>
      `[tool sessions_send ${JSON.stringify({ sessionKey, timeoutSeconds: 0, message: script }).replaceAll('[tool ', '\\u005btool ')
        .replaceAll('hit the limit', '\\u0068it the limit')}]`;
    const lead = (tail: string, target: string, script = '[tool report {"text":"done"}]', events?: RunEvent[]) =>
      kit.run({ member: 'm1', helper: 'research', sessionKey: `agent:m1:h-research:${tail}`, ...sol, tools: ['report'],
        helperDelegates: { writer: ['report'], planner: ['report'] }, message: send(target, script) }, (e) => events?.push(e));
    const ref = (r: RunRef) => [r.member, r.helper, r.agentId, r.sessionKey, r.parent?.sessionKey];
    // The targets are the helpers' standing sessions (their turns above): the pin's send reaches only an existing session.
    const targets = [[`agent:${agent}:h-writer:main`, 'writer', agent, 'lead'], ['agent:byokit-key-m1:h-planner:main', 'planner', 'byokit-key-m1', 'plan']] as const;
    for (const [target, helper, , tail] of targets) {
      const from = stub.calls.length;
      const end = await lead(tail, target);
      assert.ok(end.ok, `${target}: ${JSON.stringify(end)}`);
      await until(() => called.some((r) => r.sessionKey === target), `${target} never called`);
      // A native send carries no system text: the child's own model request carries its helper's persona as system text.
      const system = (c: (typeof stub.calls)[number]) => JSON.stringify(c.body.messages?.filter((m) => ['system', 'developer'].includes(m.role ?? '')));
      assert.ok(stub.calls.slice(from).some((c) => system(c).includes(persona(helper)) && !system(c).includes(persona('research'))),
        `${helper} child speaks as its persona`);
    }
    const expected = targets.map(([target, helper, owner, tail]) => ['m1', helper, owner, target, `agent:${agent}:h-research:${tail}`]);
    assert.deepEqual(gated.map(ref), expected, 'each child is gated as its helper');
    assert.deepEqual(called.map(ref), expected, 'each child is called as its helper');
    console.log('delegated helper runs:', JSON.stringify(called.map(ref)));
    // Each child's lifecycle by helper, from the engine's own stream: admitted with its tool subset, then one finished end.
    const ends = (helper: string) => delegated.filter((e) => e.type === 'ended' && e.run.helper === helper);
    await until(() => ends('writer').length === 1 && ends('planner').length === 1, 'children never ended');
    for (const helper of ['writer', 'planner']) {
      const life = delegated.filter((e) => e.run.helper === helper);
      assert.deepEqual(life[0]!.run.tools, ['report']);
      assert.deepEqual([life[0]!.type, life.at(-1)!.type, life.at(-1)!.reason], ['admitted', 'ended', 'terminal']);
      assert.ok(life.some((e) => e.type === 'event' && e.event?.stream === 'tool'), `${helper} streamed its tool`);
    }
    // A run on a helper key the kit never receipted stays an unknown run: the engine runs it, the host never sees it.
    const rogue = await kit.call('agent', { agentId: agent, sessionKey: `agent:${agent}:h-writer:rogue`, provider: 'openai', model: 'gpt-5.6-sol',
      message: '[tool report {"text":"rogue"}]', idempotencyKey: 'rogue-helper-child' }) as { runId: string };
    await kit.call('agent.wait', { runId: rogue.runId, timeoutMs: 60_000 });
    assert.equal(gated.length, expected.length, 'an unregistered helper key reached the gate');
    // A helper on another account is refused typed before dispatch, carried to the parent's tool result.
    const events: RunEvent[] = [];
    assert.ok((await lead('refused', 'agent:byokit-key-m1:h-writer:job', undefined, events)).ok);
    const blocked = events.find((e) => e.type === 'tool' && e.phase === 'end');
    assert.ok(blocked?.type === 'tool' && JSON.stringify(blocked.output).includes('bound: '), JSON.stringify(blocked));
    assert.ok(!kit.delegatedRuns().some((r) => r.agentId === 'byokit-key-m1' && r.helper === 'writer'));
    // Aborting the root ends the child's admission: its parked approval goes and nothing is called.
    const rooted = (r: RunRef) => r.root?.sessionKey === `agent:${agent}:h-research:abort`;
    assert.ok((await lead('abort', `agent:${agent}:h-writer:main`, '[tool report {"mode":"ask"}]')).ok);
    await until(() => kit.approvals().length === 1, 'writer never parked');
    const parked = kit.approvals()[0]!;
    assert.deepEqual([parked.member, parked.helper, parked.sessionKey], ['m1', 'writer', `agent:${agent}:h-writer:main`]);
    assert.ok(kit.delegatedRuns().some(rooted), 'the parked child is admitted');
    await kit.abort('agent:m1:h-research:abort');
    assert.equal(kit.approvals().length, 0);
    await assert.rejects(kit.decide(parked.id, { allow: true }), /unknown approval/);
    assert.equal(called.length, expected.length, 'a revoked child ran a tool');
    assert.ok(!kit.delegatedRuns().some(rooted), 'abort ended the child\'s admission');
    assert.ok(delegated.some((e) => e.type === 'ended' && e.reason === 'cancelled' && rooted(e.run)), 'the abort reached the app');
    // The model's usage limit ends a child `resting`, and its helper's account rests until then, as a kit run's would.
    const restFrom = delegated.length;
    // Scripted, so the stub answers this turn and not an earlier one of the session's history.
    assert.ok((await lead('limit', `agent:${agent}:h-writer:main`, '[tool report {"text":"limit"}] hit the limit')).ok);
    await until(() => delegated.slice(restFrom).some((e) => e.type === 'ended'), 'the limited child never ended');
    const rested = delegated.slice(restFrom).find((e) => e.type === 'ended')!;
    assert.deepEqual([rested.run.helper, rested.reason], ['writer', 'resting'], JSON.stringify(rested));
    const account = (await kit.accounts('m1')).find((a) => a.id === 'openai.aaaaaa')!;
    assert.deepEqual([account.state, account.until], ['resting', rested.until]);
    console.log('PASS delegated helpers: exact receipted children admitted as writer and planner, rogue key refused, typed bound refusal, abort revokes; lifecycle by helper: tools, approval owner, finished, cancelled, resting rests the account');

    assert.deepEqual(stores(), before, 'running helpers leaves the sign-ins byte for byte');
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id).sort(), rows.map(([id]) => id), 'no new sign-in');
    const files = readFileSync(join(root, 'helpers', 'm1', 'research.json'), 'utf8');
    assert.ok(!files.includes(accountKey) && !files.includes(planKey), 'a helper record holds no key');


  } finally { await kit.stop(); mock.restoreAll(); syncBuiltinESMExports(); }
});
