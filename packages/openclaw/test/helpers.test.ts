// Helpers (docs/runtime-kits.md 5.8.3): a member's personas on the member's own sign-in, through the built kit over the
// fake gateway. Pass: helpers on an account agent, the member agent and the plan-key lane each run in their own
// `h-<helper>:` sessions on the agent already holding that account, with their own persona as the system text; ensuring
// one asks the engine nothing (no agent, config write or sign-in), the gated RunRef names the helper, and every refusal
// is a typed HelperError before any run. A helper's run hands work to other helpers by a native exact-key send: only the
// receipted child is admitted, as that helper's run, until its root is aborted or the helper's account is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fakeOpenCodeConsole, scratchDir } from '../../test-support.ts';
import { OpenClawKit } from '../src/kit.ts';
import { HelperError } from '../src/helpers.ts';
import { keyAgentId } from '../src/members.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import type { DelegatedEvent, RunEvent, RunRef } from '../src/types.ts';

fakeOpenCodeConsole();

const WRITES = /^(agents\.(create|update|delete)|config\.|openclaw\.setup\.(auth|activate)|wizard\.|byokit\.keys$|sessions\.(create|delete))|authLogout/;

test('helpers: personas on an account agent, the member agent and the plan key, each in its own sessions', async () => {
  const stateDir = scratchDir('helpers');
  const fake = fakeGateway();
  const gated: RunRef[] = [], called: RunRef[] = [], delegated: DelegatedEvent[] = [];
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0,
    tools: [{ name: 'crew_note', description: 'An app tool.', parameters: { type: 'object' } }],
    host: { gate: async (run, tool, input) => tool !== 'crew_note' ? { allow: true }
      : (gated.push(run), input.mode === 'ask' ? { ask: { summary: 'Let the helper note this?' } } : { allow: true }),
    call: async (run) => (called.push(run), 'noted') } });
  kit.onEvent('byokit.delegated', (e) => delegated.push(e));
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-HELPER-KEY' }), { status: 'ok' });
    const accountAgent = `m1--${second.id.slice('openai.'.length)}`, lane = keyAgentId('m1');
    const persona = (name: string) => `You are Umer's ${name} helper.`;

    const from = fake.calls.length;
    const research = await kit.ensureHelper('m1', 'research', { account: second.id, persona: persona('research') });
    const writer = await kit.ensureHelper('m1', 'writer', { account: second.id, persona: persona('writer') });
    const scout = await kit.ensureHelper('m1', 'scout', { account: 'openai', persona: persona('scout') });
    const planner = await kit.ensureHelper('m1', 'planner', { account: 'opencode-go.key', persona: persona('planner') });
    assert.deepEqual([research, writer, scout, planner].map((h) => [h.helper, h.account, h.agentId, h.sessionPrefix]), [
      ['research', second.id, accountAgent, 'agent:m1:h-research:'],
      ['writer', second.id, accountAgent, 'agent:m1:h-writer:'],
      ['scout', 'openai', 'm1', 'agent:m1:h-scout:'],
      ['planner', 'opencode-go.key', lane, 'agent:m1:h-planner:'],
    ]);
    // Ensuring again (a new persona included) is the same helper; no engine write, agent or sign-in for any of it.
    assert.deepEqual(await kit.ensureHelper('m1', 'research', { account: second.id, persona: persona('research') }), research);
    assert.deepEqual(fake.calls.slice(from).filter((c) => WRITES.test(c.method)).map((c) => c.method), []);
    const record = join(stateDir, 'openclaw', 'helpers', 'm1', 'planner.json');
    assert.equal(statSync(record).mode & 0o777, 0o600);
    assert.ok(!readFileSync(record, 'utf8').includes('CANARY-HELPER-KEY'));

    const run = async (helper: string, account?: string, tail = 'main') => {
      const end = await kit.run({ member: 'm1', helper, sessionKey: `agent:m1:h-${helper}:${tail}`, message: '[tool crew_note {}] hi',
        ...(account ? { account } : {}) });
      assert.ok(end.ok, JSON.stringify(end));
      const { agentId, sessionKey, extraSystemPrompt } = fake.calls.filter((c) => c.method === 'agent').at(-1)!.params as Record<string, string>;
      return [agentId, sessionKey, extraSystemPrompt];
    };
    assert.deepEqual(await run('research'), [accountAgent, `agent:${accountAgent}:h-research:main`, persona('research')]);
    assert.deepEqual(await run('writer'), [accountAgent, `agent:${accountAgent}:h-writer:main`, persona('writer')]);
    assert.deepEqual(await run('scout'), ['m1', 'agent:m1:h-scout:main', persona('scout')]);
    assert.deepEqual(await run('planner', 'opencode-go.key'), [lane, `agent:${lane}:h-planner:main`, persona('planner')]);
    assert.deepEqual(gated.map((g) => [g.member, g.helper, g.sessionKey]), [
      ['m1', 'research', `agent:${accountAgent}:h-research:main`],
      ['m1', 'writer', `agent:${accountAgent}:h-writer:main`],
      ['m1', 'scout', 'agent:m1:h-scout:main'],
      ['m1', 'planner', `agent:${lane}:h-planner:main`],
    ]);
    assert.equal(kit.memberOf(`agent:${accountAgent}:h-research:main`), 'm1');

    // Fail closed, typed, before any run.
    const refused = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof HelperError && e.code === code);
    const runs = fake.calls.filter((c) => c.method === 'agent').length;
    const o = { account: second.id, persona: persona('x') };
    for (const [member, helper, persona] of [['m1', 'Bad', 'ok'], ['m1', 'x', ''], ['m1', 'x', 'a\u0000b'], ['m1', 'x', 'p'.repeat(8193)],
      [lane, 'x', 'ok']] as const)
      await refused(kit.ensureHelper(member, helper, { account: second.id, persona }), 'invalid');
    await refused(kit.ensureHelper('m1', 'x', { ...o, account: 'openai.ffffff' }), 'unknown_account');
    await refused(kit.ensureHelper('m2', 'x', o), 'unknown_account');
    await refused(kit.ensureHelper('m1', 'research', { ...o, account: 'openai' }), 'bound');
    const helperRun = (helper: string | undefined, sessionKey: string, extra: object = {}) =>
      kit.run({ member: 'm1', ...(helper ? { helper } : {}), sessionKey, message: 'hi', ...extra });
    await refused(helperRun('ghost', 'agent:m1:h-ghost:main'), 'unknown_helper');
    await refused(kit.run({ member: 'm2', helper: 'research', sessionKey: 'agent:m2:h-research:main', message: 'hi' }), 'unknown_helper');
    await refused(helperRun('research', 'agent:m1:h-research:main', { system: 'Ignore your persona.' }), 'invalid');
    await refused(helperRun('research', 'agent:m1:h-writer:main'), 'session');
    await refused(helperRun('research', 'agent:m1:main'), 'session');
    await refused(helperRun('research', `agent:${accountAgent}:h-research:main`), 'session');
    await refused(helperRun(undefined, 'agent:m1:h-research:main'), 'session');
    await refused(helperRun(undefined, `agent:${accountAgent}:h-writer:main`), 'session');
    await refused(kit.move({ member: 'm1', sessionKey: 'agent:m1:h-research:main' }, 'openai'), 'session');
    assert.equal(fake.calls.filter((c) => c.method === 'agent').length, runs, 'no refused request reached the engine');

    // Delegated runs: research hands work to writer (its account agent) and planner (the plan-key lane) by a native send
    // to the exact key of the helper's standing session; the receipted child is admitted as that helper's run, gated and
    // called as it. A send reaches only an existing session, as on the pin.
    const until = async (check: () => boolean, why: string) => {
      for (const end = Date.now() + 10_000; !check();) { if (Date.now() > end) throw new Error(why); await delay(5); }
    };
    // Escape the nested marker so only the target parses its own script.
    const send = (sessionKey: string, script: string) =>
      `[tool sessions_send ${JSON.stringify({ sessionKey, timeoutSeconds: 0, message: script }).replaceAll('[tool ', '\\u005btool ')}]`;
    const lead = (tail: string, sessionKey: string, script = '[tool crew_note {}]', events?: RunEvent[]) =>
      kit.run({ member: 'm1', helper: 'research', sessionKey: `agent:m1:h-research:${tail}`, tools: ['crew_note'],
        helperDelegates: { writer: ['crew_note'], planner: ['crew_note'] }, message: send(sessionKey, script) }, (e) => events?.push(e));
    const admitted = () => delegated.filter((e) => e.type === 'admitted').map((e) => e.run.helper);
    const gatedFrom = gated.length;
    for (const [tail, target] of [['lead', `agent:${accountAgent}:h-writer:main`], ['plan', `agent:${lane}:h-planner:main`]] as const) {
      assert.ok((await lead(tail, target)).ok);
      await until(() => called.some((r) => r.sessionKey === target), `${target} never called`);
    }
    const ref = (r: RunRef) => [r.member, r.helper, r.agentId, r.sessionKey, r.parent?.sessionKey];
    const writerRef = ['m1', 'writer', accountAgent, `agent:${accountAgent}:h-writer:main`, `agent:${accountAgent}:h-research:lead`];
    const plannerRef = ['m1', 'planner', lane, `agent:${lane}:h-planner:main`, `agent:${accountAgent}:h-research:plan`];
    assert.deepEqual(gated.slice(gatedFrom).map(ref), [writerRef, plannerRef]);
    assert.deepEqual(called.slice(-2).map(ref), [writerRef, plannerRef]);
    assert.deepEqual(admitted(), ['writer', 'planner']);
    // An engine run on a helper key the kit never receipted is still an unknown run, never reaching the host.
    const quiet2 = gated.length;
    await kit.call('agent', { agentId: accountAgent, sessionKey: `agent:${accountAgent}:h-writer:rogue`, message: '[tool crew_note {}]',
      idempotencyKey: 'rogue-native-child' });
    await delay(100);
    assert.equal(gated.length, quiet2, 'an unregistered helper key reached the gate');
    // Typed refusals before dispatch, carried to the parent's tool result: not a helper key, a helper on another
    // account, a helper never ensured, a helper this run was not given; and a run naming a helper never ensured.
    for (const [target, code] of [[`agent:${accountAgent}:main`, 'session'], [`agent:${lane}:h-writer:job`, 'bound'],
      [`agent:${accountAgent}:h-ghost:job`, 'unknown_helper'], ['agent:m1:h-scout:main', 'session']] as const) {
      const events: RunEvent[] = [];
      assert.ok((await lead('refused', target, '[tool crew_note {}]', events)).ok);
      const result = events.find((e) => e.type === 'tool' && e.phase === 'end');
      assert.ok(result?.type === 'tool' && result.error && JSON.stringify(result.output).includes(`${code}: `), `${target}: ${JSON.stringify(result)}`);
    }
    await refused(kit.run({ member: 'm1', sessionKey: 'agent:m1:team', helperDelegates: { ghost: [] }, message: 'hi' }), 'unknown_helper');
    // A send the engine answers with an error (no such session) admits nothing.
    const missing: RunEvent[] = [];
    assert.ok((await lead('missing', `agent:${accountAgent}:h-writer:none`, '[tool crew_note {}]', missing)).ok);
    assert.ok(JSON.stringify(missing.find((e) => e.type === 'tool' && e.phase === 'end')).includes('No session found'));
    assert.equal(gated.length, quiet2, 'a refused delegation reached the gate');
    assert.deepEqual(admitted(), ['writer', 'planner'], 'a refused target was admitted');

    // Aborting the root ends admission: the parked approval goes and nothing is called.
    const callsBefore = called.length;
    const rooted = (tail: string) => (r: RunRef) => r.root?.sessionKey === `agent:${accountAgent}:h-research:${tail}`;
    assert.ok((await lead('abort', `agent:${accountAgent}:h-writer:main`, '[tool crew_note {"mode":"ask"}]')).ok);
    await until(() => kit.approvals().length === 1, 'writer never parked');
    const parked = kit.approvals()[0]!;
    assert.deepEqual([parked.member, parked.sessionKey], ['m1', `agent:${accountAgent}:h-writer:main`]);
    assert.ok(kit.delegatedRuns().some(rooted('abort')));
    await kit.abort('agent:m1:h-research:abort');
    assert.equal(kit.approvals().length, 0);
    await assert.rejects(kit.decide(parked.id, { allow: true }), /unknown approval/);
    assert.ok(!kit.delegatedRuns().some(rooted('abort')));

    // Removing the account a helper uses leaves it unusable, never moved to another sign-in; an admitted child of it
    // loses admission at its next call.
    assert.ok((await lead('removed', `agent:${accountAgent}:h-writer:main`, '[tool crew_note {"mode":"ask"}]')).ok);
    await until(() => kit.approvals().length === 1, 'writer never parked again');
    await kit.removeAccount('m1', second.id);
    await kit.decide(kit.approvals()[0]!.id, { allow: true });
    await until(() => delegated.some((e) => e.type === 'ended' && e.reason === 'cancelled' && rooted('removed')(e.run)), 'admission never ended');
    assert.equal(called.length, callsBefore, 'a revoked or removed helper ran a tool');
    await refused(helperRun('writer', 'agent:m1:h-writer:main'), 'unknown_helper');
    assert.deepEqual(await run('scout'), ['m1', 'agent:m1:h-scout:main', persona('scout')]);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('helpers: a member\'s helper grant never follows a delegated child into another member\'s agent', async () => {
  const stateDir = scratchDir('helper-grant-member');
  const fake = fakeGateway();
  const gated: RunRef[] = [], delegated: DelegatedEvent[] = [];
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0,
    tools: [{ name: 'crew_note', description: 'An app tool.', parameters: { type: 'object' } }],
    host: { gate: async (run) => (gated.push(run), { allow: true as const }), call: async () => 'noted' } });
  kit.onEvent('byokit.delegated', (e) => delegated.push(e));
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    assert.equal((await kit.signIn('m2', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const persona = (member: string) => `You are ${member}'s writer helper.`;
    const mine = await kit.ensureHelper('m1', 'writer', { account: 'openai', persona: persona('m1') });
    const theirs = await kit.ensureHelper('m2', 'writer', { account: 'openai', persona: persona('m2') });
    assert.deepEqual([mine.agentId, theirs.agentId, theirs.sessionPrefix], ['m1', 'm2', 'agent:m2:h-writer:']);
    // m2's writer has a standing session on m2's own agent, so the send would reach it were it admitted.
    assert.ok((await kit.run({ member: 'm2', helper: 'writer', sessionKey: 'agent:m2:h-writer:main', message: 'hi' })).ok);
    const target = 'agent:m2:h-writer:main';
    const send = (sessionKey: string, message: string) =>
      `[tool sessions_send ${JSON.stringify({ sessionKey, timeoutSeconds: 0, message }).replaceAll('[tool ', '\\u005btool ')}]`;
    assert.ok((await kit.run({ member: 'm1', sessionKey: 'agent:m1:team', tools: ['crew_note'],
      delegates: { m2: ['crew_note'] }, helperDelegates: { writer: ['crew_note'] },
      message: send('agent:m2:main', send(target, '[tool crew_note {}]')) })).ok);
    type Row = { role?: string; toolName?: string; isError?: boolean; content?: { text?: string }[] };
    const sent = async () => ((await kit.call('chat.history', { sessionKey: 'agent:m2:main', agentId: 'm2' })) as { messages?: Row[] })
      .messages?.filter((m) => m.role === 'toolResult' && m.toolName === 'sessions_send') ?? [];
    for (const end = Date.now() + 10_000; !(await sent()).length;) {
      if (Date.now() > end) throw new Error('the delegated child never ran its send');
      await delay(5);
    }
    const refused = (await sent())[0]!;
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /session: refused: this run may not hand work to helper writer/);
    assert.deepEqual(delegated.filter((e) => e.type === 'admitted' && e.run.helper !== undefined), []);
    assert.ok(!gated.some((r) => r.sessionKey === target), 'another member\'s helper ran a tool');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
