// The account spine (docs/runtime-kits.md 5.15, O14 steps S5 and S6): a fake-gateway journey through the built
// kit that signs in, lists, renames, calls setDefaults, restarts and lists again, then adds a second ChatGPT
// account on its own sealed agent. Pass: expected rows, index mode 0600, clean canary scan.
// The S9 Auto input (O14i): models and room over the same journey, with the fake's cold usage cache (no usage
// on the first read). Pass: expected models and room.
// The S10 run (O14j): run({ account, model, needs }) on unbound keys. Pass: the account event comes first, Auto picks
// by room on the account's own agent and key, a resting end rests the account, a failed ready check and an empty pick
// end signed-out with no agent request, and a run with neither account nor needs is exactly the run it was.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmodSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { OpenClawKit } from '../src/kit.ts';
import { createLocks } from '../src/locks.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import type { RunEvent, SignInView } from '../src/types.ts';

const indexOf = (stateDir: string, member: string): string => join(stateDir, 'openclaw', 'accounts', `${member}.json`);

test('locks: shared overlaps, exclusive waits, live reports the hold', async () => {
  const locks = createLocks();
  assert.equal(locks.live('a1'), false);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const held = locks.shared('a1', async () => {
    assert.equal(locks.live('a1'), true);
    order.push('shared-in');
    await gate;
    order.push('shared-out');
    return 1;
  });
  const blocked = locks.exclusive(['a1'], async () => {
    order.push('exclusive');
    assert.equal(locks.live('a1'), true);
    return 2;
  });
  assert.equal(locks.live('a1'), true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(order, ['shared-in']);
  release();
  assert.deepEqual([await held, await blocked], [1, 2]);
  assert.deepEqual(order, ['shared-in', 'shared-out', 'exclusive']);
  assert.equal(locks.live('a1'), false);
});

test('account index: sign in, list, rename, defaults, restart, list again', async () => {
  const stateDir = scratchDir('o14e-accounts');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    const handle = kit.signIn('m1', { authChoice: 'openai' }, () => {});
    assert.deepEqual(await handle.done, { state: 'done', via: 'browser' });

    // A pre-O14 sign-in with no index entry is synthesized on first list.
    const listed = await kit.accounts('m1');
    assert.deepEqual(listed, [{ id: 'openai', provider: 'openai', route: 'openai', name: 'ChatGPT Login 1',
      label: 'ChatGPT Login', billing: 'subscription', state: 'ready', addedAt: 0 }]);

    // An unindexed `<member>--<hex6>` agent is never listed.
    await kit.call('agents.create', { name: 'm1--abc123', workspace: join(stateDir, 'openclaw', 'workspaces', 'm1') });
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id), ['openai']);

    const renamed = await kit.renameAccount('m1', 'openai', 'Work');
    assert.equal(renamed.name, 'Work');
    assert.equal((await kit.accounts('m1'))[0]?.name, 'Work');

    assert.deepEqual(await kit.defaults('m1'), {});
    await kit.setDefaults('m1', { account: 'openai' });
    assert.deepEqual(await kit.defaults('m1'), { account: 'openai' });
    // A default naming a removed account is dropped on read.
    await kit.setDefaults('m1', { account: 'openai.dead01' });
    assert.deepEqual(await kit.defaults('m1'), {});
    await kit.setDefaults('m1', { account: 'openai' });
    await kit.stop();

    // Restart: the rename and the default survive, and the entry is still the synthesized one.
    const again = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
    try {
      await again.start();
      assert.deepEqual(await again.accounts('m1'), [{ id: 'openai', provider: 'openai', route: 'openai',
        name: 'Work', label: 'ChatGPT Login', billing: 'subscription', state: 'ready', addedAt: 0 }]);
      assert.deepEqual(await again.defaults('m1'), { account: 'openai' });
    } finally { await again.stop(); }

    // The index is mode 0600 and holds no email, token or engine line.
    const file = indexOf(stateDir, 'm1');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, 'utf8');
    const stored = JSON.parse(text) as { v: number; accounts: Record<string, Record<string, unknown>>; defaults: object };
    assert.equal(stored.v, 1);
    assert.deepEqual(Object.keys(stored.accounts), ['openai']);
    assert.ok(!('email' in stored.accounts.openai!));
    for (const canary of ['fake-access', 'fake-refresh', 'openai:default', '@', 'accountId', 'email', 'token', 'access', 'refresh'])
      assert.ok(!text.includes(canary), `index leaks ${canary}`);

    // S6: a second ChatGPT account on its own sealed agent. wizard.next waits on `gate` so a sign-in can be
    // caught running; the first draw collides with the unindexed `m1--abc123` above and is drawn again.
    let gate: Promise<void> | undefined;
    let wrongAnswer: string | undefined;
    let loseReply = false;
    let lagging: { id: string; until: number } | undefined;
    let holdCreate: { landed: () => void; release: Promise<void> } | undefined;
    let holding: string[] | undefined;
    const gated: typeof fake.factory = (ctx) => {
      const transport = fake.factory(ctx);
      return { ...transport, request: async (method, params, o) => {
        holding?.push(method);
        if (method === 'wizard.next') await gate;
        if (method === 'agents.list' && lagging && Date.now() < lagging.until) {
          const list = await transport.request(method, params, o) as { agents: { id: string }[] };
          return { ...list, agents: list.agents.filter((a) => a.id !== lagging!.id) };
        }
        if (method !== 'agents.create') return transport.request(method, params, o);
        const made = await transport.request(method, params, o) as { agentId: string };
        if (loseReply) { loseReply = false; lagging = { id: made.agentId, until: Date.now() + 200 }; throw new Error('gateway reply lost'); }
        if (wrongAnswer !== undefined) { const answer = wrongAnswer; wrongAnswer = undefined; return { ...made, agentId: answer }; }
        if (holdCreate) {
          const hold = holdCreate;
          holdCreate = undefined;
          holding = [];
          hold.landed();
          await hold.release;
          holding = undefined;
        }
        return made;
      } };
    };
    const draws = ['abc123', 'def456'];
    const randomBytes = crypto.randomBytes;
    mock.method(crypto, 'randomBytes', (size: number) => draws.length ? Buffer.from(draws.shift()!, 'hex') : randomBytes(size));
    syncBuiltinESMExports();
    const third = new OpenClawKit({ stateDir, transport: gated, spawnEngine: false, callbackPort: 0 });
    try {
      await third.start();
      const identity = async () => (await third.call('agents.files.get', { agentId: 'm1', name: 'IDENTITY.md' })).file.content;
      const roster = async () => (await third.call('agents.list', {})).agents.map((a) => a.id);
      const identityBefore = await identity();
      assert.ok(identityBefore);
      let open!: () => void;
      gate = new Promise((resolve) => { open = resolve; });
      const views: SignInView[] = [];
      const second = await third.addAccount('m1', { authChoice: 'openai', via: 'browser' }, (v) => views.push(v));
      assert.equal(second.id, 'openai.def456', 'the taken m1--abc123 is drawn again');
      assert.ok((await roster()).includes('m1--def456'));
      assert.equal(await identity(), identityBefore, 'IDENTITY.md is byte-identical after the account agent is created');
      const entry = JSON.parse(readFileSync(file, 'utf8')).accounts['openai.def456'];
      assert.deepEqual([entry.agent, entry.name, entry.route], ['m1--def456', 'ChatGPT Login 2', 'openai']);
      assert.equal((await third.accounts('m1')).find((a) => a.id === 'openai.def456')?.state, 'signing');

      // One setup admission: a sign-in started while this one runs ends busy, and its agent and entry go.
      const busy = await third.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
      assert.match(busy.id, /^openai\.[0-9a-f]{6}$/);
      assert.deepEqual((await busy.done).view, { state: 'failed', via: 'browser', why: 'busy' });
      assert.ok(!(await roster()).includes(`m1--${busy.id.slice('openai.'.length)}`), 'the busy agent is removed');
      assert.ok(!(busy.id in JSON.parse(readFileSync(file, 'utf8')).accounts), 'and its entry');

      open();
      gate = undefined;
      assert.deepEqual(await second.done, { view: { state: 'done', via: 'browser' }, id: 'openai.def456' });
      const url = new URL(views.find((v) => v.url)!.url!);
      assert.equal(`${url.origin}${url.pathname}`, 'https://auth.openai.com/oauth/authorize');
      assert.equal(url.searchParams.get('prompt'), 'login', 'a further ChatGPT account asks for the login screen');
      assert.equal(url.searchParams.get('state'), 'fake-state', 'the rest of the URL is the engine\'s');
      assert.deepEqual(views.at(-1), { state: 'done', via: 'browser' }, 'done comes only after sealing');

      // Sealed: the account agent holds only its own sign-in, and its identity hash (never an email) is indexed.
      const sealed = await third.callDynamic('byokit.accounts', { action: 'list', agentId: 'm1--def456' }) as { profiles: { provider: string }[] };
      assert.deepEqual(sealed.profiles.map((p) => p.provider), ['openai']);
      assert.match(JSON.parse(readFileSync(file, 'utf8')).accounts['openai.def456'].who, /^[0-9a-f]{16}$/);
      assert.deepEqual((await third.accounts('m1')).map((a) => [a.id, a.name, a.state]),
        [['openai', 'Work', 'ready'], ['openai.def456', 'ChatGPT Login 2', 'ready']], 'two ChatGPT accounts on two agents');

      // A cancelled sign-in removes its new agent and entry; IDENTITY.md is still the member's.
      gate = new Promise(() => {});
      const cancelled = await third.addAccount('m1', { authChoice: 'openai', via: 'browser', name: 'Spare' }, () => {});
      cancelled.cancel();
      assert.equal((await cancelled.done).view.why, 'declined');
      gate = undefined;
      assert.ok(!(await roster()).includes(`m1--${cancelled.id.slice('openai.'.length)}`));
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).accounts), ['openai', 'openai.def456']);
      assert.equal(await identity(), identityBefore);
      const after = readFileSync(file, 'utf8');
      for (const canary of ['fake-access', 'fake-refresh', 'fake-m1', 'openai:default', '@', 'email', 'token'])
        assert.ok(!after.includes(canary), `index leaks ${canary}`);

      // A failure after agents.create (its answer names another agent) restores IDENTITY.md and removes the new agent and entry.
      const rosterBefore = await roster();
      wrongAnswer = 'm1--elsewhere';
      await assert.rejects(third.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {}), /answered m1--elsewhere/);
      assert.deepEqual(await roster(), rosterBefore, 'the agent of the failed create is removed');
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).accounts), ['openai', 'openai.def456'], 'and its entry');
      assert.equal(await identity(), identityBefore, 'IDENTITY.md is restored after the failed create');

      // The gateway made the agent, then the create reply was lost: its roster lags the reply, so the failure is the real
      // cause and the agent it made goes too once the roster shows it.
      loseReply = true;
      await assert.rejects(third.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {}), /gateway reply lost/);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, lagging!.until - Date.now()) + 1));
      assert.deepEqual(await roster(), rosterBefore, 'the agent the lost reply left behind is removed');
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).accounts), ['openai', 'openai.def456'], 'and its entry');
      assert.equal(await identity(), identityBefore, 'IDENTITY.md is restored after the lost reply');

      // Two adds on one member at once: the second waits while the first's create is held, so IDENTITY.md keeps the member's line.
      gate = new Promise(() => {});
      let landed!: () => void;
      const createLanded = new Promise<void>((resolve) => { landed = resolve; });
      let release!: () => void;
      holdCreate = { landed, release: new Promise<void>((resolve) => { release = resolve; }) };
      const racing = third.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
      await createLanded;
      const late = third.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
      for (let i = 0; i < 1000 && !holding?.includes('agents.list'); i++) await new Promise((resolve) => setImmediate(resolve));
      assert.ok(holding?.includes('agents.list'), 'the second add reaches its roster read while the first create is held');
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.ok(!holding?.includes('agents.files.get'), 'the second add reads IDENTITY.md only after the held create is restored');
      release();
      const [a, b] = await Promise.all([racing, late]);
      assert.equal(await identity(), identityBefore, 'two adds at once leave IDENTITY.md byte-identical');
      a.cancel();
      b.cancel();
      assert.notEqual((await a.done).view.state, 'done');
      assert.notEqual((await b.done).view.state, 'done');
      gate = undefined;
      assert.deepEqual(await roster(), rosterBefore, 'both new agents are removed');
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).accounts), ['openai', 'openai.def456'], 'and their entries');
      assert.equal(await identity(), identityBefore);

      // The engine's provider id names the openai route: it signs in on its own agent like any further ChatGPT account.
      const codex = await third.addAccount('m1', { authChoice: 'openai-codex', via: 'browser' }, () => {});
      assert.match(codex.id, /^openai\.[0-9a-f]{6}$/);
      assert.deepEqual(await codex.done, { view: { state: 'done', via: 'browser' }, id: codex.id });
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).accounts[codex.id].route, 'openai');
      assert.ok((await roster()).includes(`m1--${codex.id.slice('openai.'.length)}`));
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      await third.stop();
    }
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('models and room: provider/model mapping, cold usage cache, skips, unknown cases', async () => {
  const stateDir = scratchDir('o14i-models-room');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    const handle = kit.signIn('m1', { authChoice: 'openai' }, () => {});
    assert.deepEqual(await handle.done, { state: 'done', via: 'browser' });
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id), ['openai']);

    // `models.list` rows of the account's provider map to `provider/model`; another provider is filtered out.
    const resetAt = 1_797_000_100_000;
    fake.handle('models.list', () => ({ models: [
      { id: 'gpt-5.1', name: 'GPT 5.1', provider: 'openai', available: true },
      { id: 'openai/gpt-5.1-mini', name: 'Mini', provider: 'openai', available: false, unavailableReason: 'missing-auth' },
      { id: 'oops', name: 'Oops', provider: 'openai', available: false, unavailableReason: 'auth-failed' },
      { id: 'paused', name: 'Paused', provider: 'openai', available: false, unavailableReason: 'cooldown', unavailableUntil: resetAt },
      { id: 'waiting', name: 'Waiting', provider: 'openai', available: false, unavailableReason: 'cooldown' },
      { id: 'claude-x', name: 'X', provider: 'anthropic', available: true },
    ] }));
    assert.deepEqual(await kit.models('m1', 'openai'), [
      { id: 'openai/gpt-5.1', name: 'GPT 5.1', available: true },
      { id: 'openai/gpt-5.1-mini', name: 'Mini', available: false, why: 'signed_out' },
      { id: 'openai/oops', name: 'Oops', available: false, why: 'signed_out' },
      { id: 'openai/paused', name: 'Paused', available: false, why: 'resting', until: resetAt },
      { id: 'openai/waiting', name: 'Waiting', available: false, why: 'resting' },
    ]);

    // Cold usage cache: the first `models.authStatus` read carries no usage, so room is unknown.
    fake.setUsage('m1', 'openai', [
      { label: 'weekly' },
      { label: 'session', usedPercent: 80, resetAt },
      { label: 'monthly', usedPercent: 30, resetAt: resetAt + 1_000_000 },
    ]);
    assert.deepEqual(await kit.room('m1', 'openai'), { left: 'unknown' });

    // Warm: the tightest applying window (session, 80% used) gives the room. The window without a numeric
    // `usedPercent` is skipped, never read as unused; the room never carries `at`.
    const room = await kit.room('m1', 'openai');
    assert.deepEqual(room, { left: 20, span: 'session', resetsAt: resetAt });
    assert.ok(!('at' in room), 'room carries at');
    // A demand answers the same: the pin's rows carry no model scope, so every window applies.
    assert.deepEqual(await kit.room('m1', 'openai', ['openai/gpt-5.1']), room);

    // The kit adds no cache: changed windows read live.
    fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 10, resetAt }]);
    assert.deepEqual(await kit.room('m1', 'openai'), { left: 90, span: 'session', resetsAt: resetAt });

    // An API-key account's room is always unknown, with no read.
    const file = indexOf(stateDir, 'm1');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { v: number; accounts: Record<string, unknown>; defaults: object };
    stored.accounts.anthropic = { agent: 'm1', name: 'Key', route: 'apiKey', addedAt: 1 };
    writeFileSync(file, JSON.stringify(stored, null, 2) + '\n');
    chmodSync(file, 0o600);
    const keyRow = (await kit.accounts('m1')).find((a) => a.id === 'anthropic');
    assert.equal(keyRow?.billing, 'api');
    assert.deepEqual(await kit.room('m1', 'anthropic'), { left: 'unknown' });

    await assert.rejects(kit.models('m1', 'nope'), /unknown account: nope/);
    await assert.rejects(kit.room('m1', 'nope'), /unknown account: nope/);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('run on an account: account event first, Auto by room, resting skip, ready failure, none', async () => {
  const stateDir = scratchDir('o14j-run');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    // The member account has 20% left, the account agent 90%; one read each warms the fake's usage cache.
    fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 80 }]);
    fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 10 }]);
    for (const id of ['openai', second.id]) await kit.room('m1', id);
    const agentCalls = () => fake.calls.filter((c) => c.method === 'agent');
    const run = async (spec: { sessionKey: string; account?: string; needs?: string[] }) => {
      const events: RunEvent[] = [];
      let agentRequestsAtAccount = -1;
      const before = agentCalls().length;
      const end = await kit.run({ member: 'm1', message: 'hello', ...spec }, (e) => {
        if (e.type === 'account') agentRequestsAtAccount = agentCalls().length - before;
        events.push(e);
      });
      return { end, events, requests: agentCalls().slice(before), agentRequestsAtAccount };
    };

    // Neither account nor needs: the member agent's run, request for request, with no account event and no pick.
    const plainFrom = fake.calls.length;
    const plain = await kit.run({ member: 'm1', sessionKey: 'agent:m1:plain', message: 'hello', idempotencyKey: 'k-plain' });
    assert.deepEqual(plain, { ok: true, text: 'fake: hello', usage: { input: 5, output: 11, total: 16 },
      planWindow: { provider: 'openai', windows: [{ label: 'session', usedPercent: 80 }] } });
    assert.deepEqual(fake.calls.slice(plainFrom).find((c) => c.method === 'agent')?.params,
      { agentId: 'm1', sessionKey: 'agent:m1:plain', message: 'hello', idempotencyKey: 'k-plain' });
    assert.ok(!fake.calls.slice(plainFrom).some((c) => c.method === 'byokit.accounts' || c.method === 'models.list'), 'no pick');

    // Auto: the account with the most room, on its own agent under the app key's tail; the account event comes first.
    const auto = await run({ sessionKey: 'agent:m1:chat:1', account: 'auto' });
    const event = auto.events[0];
    assert.ok(event?.type === 'account', JSON.stringify(auto.events));
    assert.deepEqual({ ...event, considered: undefined }, { type: 'account', account: second.id, model: 'openai/default',
      sessionKey: `agent:${agent}:chat:1`, how: 'auto', why: 'most_room', considered: undefined });
    assert.deepEqual(event.considered.map((r) => [r.id, r.left, r.tier, r.reason]),
      [['openai', 20, 'room', 'most_room'], [second.id, 90, 'room', 'most_room']]);
    assert.equal(auto.agentRequestsAtAccount, 0, 'the account event comes before the agent request');
    assert.equal(auto.requests.length, 1);
    assert.deepEqual([auto.requests[0]!.params].map((p) => { const { agentId, sessionKey, provider, model } = p as Record<string, unknown>;
      return { agentId, sessionKey, provider, model }; }), [{ agentId: agent, sessionKey: `agent:${agent}:chat:1`, provider: 'openai', model: 'default' }]);
    assert.ok(auto.end.ok && auto.end.account === second.id && auto.end.model === 'openai/default', JSON.stringify(auto.end));

    // A fresh account whose models.list is refused has no known catalog: Auto still runs it, with no model override.
    fake.handle('models.list', (p) => {
      if (p.agentId === agent) throw new Error('models.list refused');
      return { models: [{ id: 'default', name: 'Default', provider: 'openai', available: true }] };
    });
    const refused = await run({ sessionKey: 'agent:m1:chat:refused', account: 'auto' });
    assert.ok(refused.end.ok && refused.end.account === second.id && refused.end.model === '', JSON.stringify(refused.end));
    assert.deepEqual([refused.requests[0]!.params].map((p) => { const { agentId, provider, model } = p as Record<string, unknown>;
      return { agentId, provider, model }; }), [{ agentId: agent, provider: undefined, model: undefined }]);

    // A resting end writes `until` to the index; the account reads resting and the next Auto skips it. `needs` alone
    // resolves as 'default', which with no saved default is Auto.
    fake.failNext('agent', 'You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.');
    const rested = await run({ sessionKey: 'agent:m1:chat:2', account: 'auto' });
    assert.ok(!rested.end.ok && 'kind' in rested.end && rested.end.kind === 'resting' && rested.end.until, JSON.stringify(rested.end));
    const until = rested.end.until;
    assert.ok(Math.abs(until - (Date.now() + 30 * 60_000)) < 60_000);
    assert.equal(JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts[second.id].until, until);
    assert.equal((await kit.accounts('m1')).find((a) => a.id === second.id)?.state, 'resting');
    const skipped = await run({ sessionKey: 'agent:m1:chat:3', needs: ['openai/default'] });
    const skip = skipped.events[0];
    assert.ok(skip?.type === 'account' && skip.account === 'openai' && skip.how === 'auto', JSON.stringify(skipped.events));
    assert.deepEqual(skip.considered.find((r) => r.id === second.id), { id: second.id, left: 90, age: 'unknown',
      confidence: 'unknown', reason: 'resting', span: 'session', out: 'resting', until });
    assert.equal((skipped.requests[0]!.params as { agentId: string }).agentId, 'm1');
    assert.equal((skipped.requests[0]!.params as { sessionKey: string }).sessionKey, 'agent:m1:chat:3');
    assert.ok(skipped.end.ok && skipped.end.account === 'openai');

    // A chosen account whose own sign-in fails its ready check ends signed-out before any agent request. Its models
    // read unavailable for the missing sign-in, as the engine reports them, and still count as its plan.
    await kit.callDynamic('byokit.accounts', { action: 'clear', agentId: agent });
    fake.handle('models.list', (p) => ({ models: [{ id: 'default', name: 'Default', provider: 'openai',
      ...(p.agentId === agent ? { available: false, unavailableReason: 'missing-auth' } : { available: true }) }] }));
    const signedOut = await run({ sessionKey: 'agent:m1:chat:4', account: second.id });
    const name = (await kit.accounts('m1')).find((a) => a.id === second.id)!.name;
    assert.deepEqual(signedOut.end, { ok: false, kind: 'signed-out', message: `${name} is not signed in` });
    assert.deepEqual([signedOut.events, signedOut.requests], [[], []]);

    // The member account rests too: Auto has no candidate, so the run ends signed-out with no agent request.
    fake.failNext('agent', 'usage limit reached');
    const memberRested = await run({ sessionKey: 'agent:m1:chat:5', account: 'auto' });
    assert.ok(!memberRested.end.ok && 'kind' in memberRested.end && memberRested.end.kind === 'resting');
    assert.ok(Math.abs(memberRested.end.until! - (Date.now() + 5 * 60_000)) < 60_000, 'no time named: five minutes');
    const none = await run({ sessionKey: 'agent:m1:chat:6', account: 'auto' });
    assert.deepEqual(none.end, { ok: false, kind: 'signed-out', message: 'No signed-in openai account.' });
    assert.deepEqual([none.events, none.requests], [[], []]);

    await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:7', message: 'hi', account: 'openai.ffffff' }),
      /unknown account: openai\.ffffff/);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
