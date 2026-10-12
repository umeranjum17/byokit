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
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
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
    const emptyFrom = fake.calls.length;
    const empty = await kit.run({ member: 'm1', sessionKey: 'agent:m1:plain', message: 'hello', idempotencyKey: 'k-empty', needs: [] });
    assert.deepEqual(empty, plain);
    assert.deepEqual(fake.calls.slice(emptyFrom).find((c) => c.method === 'agent')?.params,
      { agentId: 'm1', sessionKey: 'agent:m1:plain', message: 'hello', idempotencyKey: 'k-empty' });
    assert.ok(!fake.calls.slice(emptyFrom).some((c) => c.method === 'byokit.accounts' || c.method === 'models.list'), 'empty needs is no needs');

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
    assert.ok(refused.end.ok && refused.end.account === second.id && refused.end.model === 'openai/gpt-5.1', JSON.stringify(refused.end));
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
    assert.deepEqual([signedOut.events.map((e) => e.type), signedOut.requests], [['account'], []]);
    assert.ok(signedOut.events[0]?.type === 'account' && signedOut.events[0].account === second.id);

    // Every model of the member account is cooling down: Auto skips it and runs the next ready account; a chosen
    // member ends resting with the earliest cooldown written to the index.
    const resetAt = Date.now() + 20 * 60_000;
    const third = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await third.done).view.state, 'done');
    const thirdAgent = `m1--${third.id.slice('openai.'.length)}`;
    fake.setUsage(thirdAgent, 'openai', [{ label: 'session', usedPercent: 50 }]);
    fake.handle('models.list', (p) => ({ models: [{ id: 'default', name: 'Default', provider: 'openai',
      ...(p.agentId === 'm1' ? { available: false, unavailableReason: 'cooldown', unavailableUntil: resetAt } : { available: true }) }] }));
    const cooled = await run({ sessionKey: 'agent:m1:chat:cool', account: 'auto' });
    const coolEvent = cooled.events[0];
    assert.ok(coolEvent?.type === 'account' && coolEvent.account === third.id && coolEvent.how === 'auto', JSON.stringify(cooled.events));
    assert.ok(coolEvent.considered.find((r) => r.id === 'openai')?.out === 'resting');
    assert.deepEqual(cooled.requests.map((r) => (r.params as { agentId: string }).agentId), [thirdAgent]);
    assert.ok(cooled.end.ok && cooled.end.account === third.id, JSON.stringify(cooled.end));
    const cooling = await run({ sessionKey: 'agent:m1:chat:cooling', account: 'openai' });
    assert.ok(!cooling.end.ok && 'kind' in cooling.end && cooling.end.kind === 'resting' && cooling.end.until === resetAt, JSON.stringify(cooling.end));
    assert.deepEqual([cooling.events, cooling.requests], [[], []]);
    assert.equal(JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts.openai.until, resetAt);

    // Every account now rests: the Auto winner rests with no time named, and the next Auto has no candidate, so the
    // run ends signed-out with no agent request.
    fake.failNext('agent', 'usage limit reached');
    const memberRested = await run({ sessionKey: 'agent:m1:chat:5', account: 'auto' });
    assert.ok(!memberRested.end.ok && 'kind' in memberRested.end && memberRested.end.kind === 'resting');
    assert.ok(Math.abs(memberRested.end.until! - (Date.now() + 5 * 60_000)) < 60_000, 'no time named: five minutes');
    const none = await run({ sessionKey: 'agent:m1:chat:6', account: 'auto' });
    assert.ok(!none.end.ok && 'kind' in none.end && none.end.kind === 'resting' && none.end.until === memberRested.end.until,
      JSON.stringify(none.end));
    assert.deepEqual([none.events, none.requests], [[], []]);

    await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:7', message: 'hi', account: 'openai.ffffff' }),
      /unknown account: openai\.ffffff/);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('run on an account: abort with the member key reaches the account run; an Auto pick not signed in falls through', async () => {
  const stateDir = scratchDir('o14j-route');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 80 }]);
    fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 10 }]);
    for (const id of ['openai', second.id]) await kit.room('m1', id);

    const aborted = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:1', message: 'hello', account: 'auto' }, (e) => {
      if (e.type === 'started') void kit.abort('agent:m1:chat:1');
    });
    assert.deepEqual(aborted, { ok: false, aborted: true });
    assert.deepEqual(fake.calls.filter((c) => c.method === 'chat.abort').map((c) => (c.params as { sessionKey: string }).sessionKey),
      [`agent:${agent}:chat:1`]);

    await kit.callDynamic('byokit.accounts', { action: 'clear', agentId: agent });
    const events: RunEvent[] = [];
    const from = fake.calls.length;
    const fell = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:2', message: 'hello', account: 'auto' }, (e) => events.push(e));
    assert.ok(events[0]?.type === 'account' && events[0].account === 'openai' && events[0].how === 'auto', JSON.stringify(events));
    assert.ok(fell.ok && fell.account === 'openai', JSON.stringify(fell));
    assert.deepEqual(fake.calls.slice(from).filter((c) => c.method === 'agent').map((c) => (c.params as { agentId: string }).agentId), ['m1']);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// S7 (O14g): identity merge. The fake stores an account id per sign-in (`signInAs`), so `who` is that sign-in's.
// Pass: the rows match the runtime-kits O14 identity bullets and no `who` or account id reaches the app.
test('identity: same who refreshes, again with another who adds, no who never merges, old duplicates adopt into the earliest', async () => {
  const stateDir = scratchDir('o14g-identity');
  const fake = fakeGateway();
  let refuseAdopt = false;
  let loseAdoptReply = false;
  let loseAdoptBeforeMove = false;
  let armMemberRead = false;
  let failMemberRead = false;
  let armRosterRead = false;
  let failRosterRead = false;
  const adopts: { from: string; to: string }[] = [];
  const refusing: typeof fake.factory = (ctx) => {
    const transport = fake.factory(ctx);
    return { ...transport, request: async (method, params, o) => {
      if (method === 'agents.list' && failRosterRead) { failRosterRead = false; throw new Error('roster read failed'); }
      if (method !== 'byokit.accounts') return transport.request(method, params, o);
      const { action, agentId } = params as { action?: string; agentId?: string };
      if (action === 'seal' && armMemberRead) { armMemberRead = false; failMemberRead = true; }
      if (action === 'seal' && armRosterRead) { armRosterRead = false; failRosterRead = true; }
      if (action === 'list' && failMemberRead && agentId === 'm1') { failMemberRead = false; return { ok: false }; }
      if (action !== 'adopt') return transport.request(method, params, o);
      adopts.push(params as { from: string; to: string });
      if (refuseAdopt) { refuseAdopt = false; return { ok: false }; }
      if (loseAdoptBeforeMove) {
        loseAdoptBeforeMove = false;
        await transport.request('byokit.accounts', { action: 'clear', agentId: (params as { from: string }).from }, o);
        throw new Error('gateway reply lost');
      }
      const answer = await transport.request(method, params, o);
      if (loseAdoptReply) { loseAdoptReply = false; throw new Error('gateway reply lost'); }
      return answer;
    } };
  };
  const lines: string[] = [];
  const kit = new OpenClawKit({ stateDir, transport: refusing, spawnEngine: false, callbackPort: 0, log: (line) => lines.push(line) });
  const seen: unknown[] = [];
  const whoOf = (accountId: string) => crypto.createHash('sha256').update(`openai\n${accountId}`).digest('hex').slice(0, 16);
  const index = () => JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')) as { accounts: Record<string, { agent: string; name: string; route: string; addedAt: number; until?: number; model?: string; who?: string }> };
  const rows = async () => { const listed = await kit.accounts('m1'); seen.push(listed); return listed.map((a) => [a.id, a.state]); };
  const ready = (id: string) => kit.callDynamic('byokit.accounts', { action: 'ready', agentId: index().accounts[id]!.agent, provider: 'openai' }) as
    Promise<{ ok: boolean; who?: string; expiresAt?: number }>;
  const add = async (again?: string) => {
    const handle = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', ...(again ? { again } : {}) }, (v) => seen.push(v));
    const done = await handle.done;
    seen.push(done);
    assert.equal(done.view.state, 'done');
    return { added: handle.id, id: done.id };
  };
  const roster = async () => (await kit.call('agents.list', {})).agents.map((a) => a.id);
  try {
    await kit.start();
    const later = Date.now() + 40 * 86_400_000;

    // The first ChatGPT sign-in lands on the member agent, its who indexed.
    fake.signInAs({ accountId: 'canary-acct-a', email: 'umer@example.com' });
    assert.deepEqual(await add(), { added: 'openai', id: 'openai' });
    assert.equal(index().accounts.openai!.who, whoOf('canary-acct-a'));

    // Duplicate identity: the same account id with a changed email refreshes the existing row; the new agent goes.
    fake.signInAs({ accountId: 'canary-acct-a', email: 'umer+new@example.com', expires: later });
    const refreshed = await add();
    assert.match(refreshed.added, /^openai\.[0-9a-f]{6}$/);
    assert.equal(refreshed.id, 'openai', 'done names the existing account');
    assert.deepEqual(await rows(), [['openai', 'ready']], 'one row');
    assert.ok(!(await roster()).includes(`m1--${refreshed.added.slice(7)}`), 'the new agent is removed');
    assert.deepEqual(Object.keys(index().accounts), ['openai'], 'and its entry');
    assert.deepEqual(await ready('openai'), { ok: true, type: 'oauth', expiresAt: later, who: whoOf('canary-acct-a') }, 'the member now holds the new sign-in');

    // Wrong-account re-auth: again = X signing in to another identity adds a row, and X keeps billing X.
    fake.signInAs({ accountId: 'canary-acct-b', email: 'umer@example.com' });
    const b = await add('openai');
    assert.equal(b.id, b.added);
    assert.deepEqual(await rows(), [['openai', 'ready'], [b.id, 'ready']]);
    assert.deepEqual(await ready('openai'), { ok: true, type: 'oauth', expiresAt: later, who: whoOf('canary-acct-a') }, 'X is untouched');
    assert.equal((await ready(b.id)).who, whoOf('canary-acct-b'));

    // again = Y signing in to X's identity adopts into X and leaves Y untouched.
    fake.signInAs({ accountId: 'canary-acct-a', expires: later + 1 });
    assert.equal((await add(b.id)).id, 'openai');
    assert.equal((await ready('openai')).expiresAt, later + 1);
    assert.equal((await ready(b.id)).who, whoOf('canary-acct-b'));
    assert.equal((await rows()).length, 2);

    // Missing identity: a sign-in without an account id never merges, even with again and the same email.
    fake.signInAs({ accountId: undefined, email: 'umer@example.com' });
    const c = await add();
    const d = await add(c.id);
    assert.deepEqual([c.id === c.added, d.id === d.added, c.id !== d.id], [true, true, true]);
    assert.ok(!('who' in index().accounts[c.id]!) && !('who' in index().accounts[d.id]!));
    assert.equal((await rows()).length, 4);

    // An adopt the engine refuses leaves the sign-in a new account, its who kept for later matches.
    fake.signInAs({ accountId: 'canary-acct-b' });
    refuseAdopt = true;
    const kept = await add();
    assert.equal(kept.id, kept.added);
    assert.equal(index().accounts[kept.id]!.who, whoOf('canary-acct-b'));
    assert.equal((await rows()).length, 5);

    // The engine moved the sign-in but its adopt reply was lost: the kit sees it moved, so no stray row is left.
    fake.signInAs({ accountId: 'canary-acct-b', expires: later + 2 });
    loseAdoptReply = true;
    assert.equal((await add()).id, b.id, 'the earlier of the two rows holding that who');
    assert.equal((await ready(b.id)).expiresAt, later + 2);
    assert.equal((await rows()).length, 4, 'the refused row kept by the earlier sign-in merges away');

    // Two pre-O14 accounts sharing a who: a sign-in with it moves the later one's credential into the earlier addedAt
    // (d, not n), removes n, then adopts into d. c holds no credential, so it is left alone.
    fake.signInAs({ accountId: 'canary-acct-e' });
    const n = await add(c.id);
    const dupAgent = index().accounts[n.id]!.agent;
    const file = index() as { accounts: Record<string, { addedAt: number; who?: string }> };
    file.accounts[d.id]!.who = whoOf('canary-acct-e');
    file.accounts[d.id]!.addedAt = 1;
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(file, null, 2) + '\n');
    const dAgent = index().accounts[d.id]!.agent;
    fake.signInAs({ accountId: 'canary-acct-e' });
    const adoptsBeforeDup = adopts.length;
    assert.equal((await add()).id, d.id);
    assert.deepEqual(adopts.slice(adoptsBeforeDup).map((a) => [a.from, a.to]).slice(0, 1), [[dupAgent, dAgent]], 'the later duplicate moves into the earliest first');
    assert.equal(adopts.length - adoptsBeforeDup, 2, 'then the sign-in');
    assert.equal(index().accounts[n.id], undefined, 'n merges into d');
    assert.equal((await ready(d.id)).who, whoOf('canary-acct-e'));
    assert.equal((await rows()).length, 4);

    // The member agent signing in again to its signed-out account's who: that account, nothing adopted or cleared.
    await kit.signOut('m1', 'openai');
    assert.equal((await kit.accounts('m1'))[0]?.state, 'signed_out');
    fake.signInAs({ accountId: 'canary-acct-a' });
    assert.deepEqual(await add(), { added: 'openai', id: 'openai' });
    assert.equal((await ready('openai')).who, whoOf('canary-acct-a'));
    assert.equal((await ready(b.id)).who, whoOf('canary-acct-b'));
    assert.equal((await rows()).length, 4);

    // The member row and an earlier pre-O14 account share a who: the member's sign-in adopts into the earlier one
    // and the member's primary model goes back to what it was before that sign-in.
    await kit.signOut('m1', 'openai');
    const configOf = async () => await kit.call('config.get', {}) as { hash: string; config: { agents: { entries: Record<string, { model?: unknown }> } } };
    await kit.call('config.patch', { raw: JSON.stringify({ agents: { ownership: 'explicit', entries: { m1: { model: 'openai/before-sign-in' } } } }), baseHash: (await configOf()).hash });
    const before = (await configOf()).config.agents.entries.m1!.model;
    const shared = index();
    shared.accounts.openai!.who = whoOf('canary-acct-a');
    shared.accounts[b.id]!.who = whoOf('canary-acct-a');
    shared.accounts[b.id]!.addedAt = 1;
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(shared, null, 2) + '\n');
    fake.signInAs({ accountId: 'canary-acct-a', expires: later + 3 });
    assert.deepEqual(await add(), { added: 'openai', id: b.id }, 'the earlier account takes the sign-in');
    assert.equal((await ready(b.id)).expiresAt, later + 3);
    assert.equal(index().accounts.openai, undefined, 'the member row merges away');
    assert.equal((await configOf()).config.agents.entries.m1!.model, before, 'the member primary model is restored');
    assert.equal((await rows()).length, 3);

    // The member row holds the sign-in and an earlier openai row shares its who: the member row merges into the earlier one.
    fake.signInAs({ accountId: 'canary-acct-z' });
    assert.deepEqual(await add(), { added: 'openai', id: 'openai' }, 'the member holds the new sign-in');
    const earlier = index();
    earlier.accounts[b.id]!.who = whoOf('canary-acct-z');
    earlier.accounts[b.id]!.addedAt = 1;
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(earlier, null, 2) + '\n');
    const memberBefore = (await configOf()).config.agents.entries.m1!.model;
    fake.signInAs({ accountId: 'canary-acct-z', expires: later + 4 });
    const merged = await add();
    assert.match(merged.added, /^openai\.[0-9a-f]{6}$/);
    assert.equal(merged.id, b.id, 'the earlier account takes the sign-in');
    assert.equal(index().accounts.openai, undefined, 'the member row merged away');
    assert.equal((await configOf()).config.agents.entries.m1!.model, memberBefore, 'the member primary model is unchanged by the merge');
    assert.equal((await ready(b.id)).expiresAt, later + 4);
    assert.equal((await rows()).length, 3);

    // A removal that stopped partway left an entry whose agent is gone, still carrying the who: it is skipped.
    const dead = index();
    dead.accounts['openai.dead00'] = { agent: 'm1--dead00', name: 'Gone', route: 'openai', addedAt: 0, who: whoOf('canary-acct-z') };
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(dead, null, 2) + '\n');
    fake.signInAs({ accountId: 'canary-acct-z', expires: later + 5 });
    assert.equal((await add()).id, b.id, 'the sign-in merges into the live row');
    assert.equal((await ready(b.id)).expiresAt, later + 5);
    assert.equal((await rows()).length, 3);

    // A signed-out member row keeps its who but holds nothing: it is no holder, so the earlier live row takes the sign-in and the row stays.
    fake.signInAs({ accountId: 'canary-acct-y' });
    assert.deepEqual(await add(), { added: 'openai', id: 'openai' }, 'the member holds a sign-in');
    await kit.signOut('m1', 'openai');
    assert.equal((await kit.accounts('m1')).find((r) => r.id === 'openai')?.state, 'signed_out');
    const stale = index();
    stale.accounts[b.id]!.who = whoOf('canary-acct-y');
    stale.accounts[b.id]!.addedAt = 1;
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(stale, null, 2) + '\n');
    const adoptsBefore = adopts.length;
    const logBefore = lines.length;
    fake.signInAs({ accountId: 'canary-acct-y', expires: later + 6 });
    assert.equal((await add(b.id)).id, b.id, 'the earliest live row takes the sign-in');
    assert.deepEqual(adopts.slice(adoptsBefore).filter((a) => a.from === 'm1' || a.to === 'm1'), [], 'the signed-out member is never adopted from or into');
    assert.ok(!lines.slice(logBefore).some((line) => line.includes('is kept')), 'no duplicate is kept');
    assert.equal((await ready(b.id)).expiresAt, later + 6);
    assert.equal(index().accounts.openai?.who, whoOf('canary-acct-y'), 'the signed-out member row stays');
    assert.equal((await kit.accounts('m1')).find((r) => r.id === 'openai')?.state, 'signed_out');
    assert.equal((await rows()).length, 4);

    // The member's profiles cannot be read after the seal: the sign-in is kept as its own row, nothing adopted or merged.
    fake.signInAs({ accountId: 'canary-acct-q' });
    assert.deepEqual(await add(), { added: 'openai', id: 'openai' }, 'the signed-out member takes the sign-in');
    const withQ = index();
    withQ.accounts[b.id]!.who = whoOf('canary-acct-q');
    withQ.accounts[b.id]!.addedAt = 1;
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(withQ, null, 2) + '\n');
    fake.signInAs({ accountId: 'canary-acct-q', expires: later + 7 });
    armMemberRead = true;
    const adoptsBeforeRead = adopts.length;
    const logBeforeRead = lines.length;
    const unmerged = await add();
    assert.equal(unmerged.id, unmerged.added, 'the sign-in keeps its own row');
    assert.notEqual(unmerged.id, b.id, 'the earlier row holding that who is not taken');
    assert.deepEqual(adopts.slice(adoptsBeforeRead), [], 'no adopt');
    assert.equal(index().accounts[unmerged.id]!.who, whoOf('canary-acct-q'));
    assert.ok(lines.slice(logBeforeRead).some((line) => line.includes('unreadable')), 'the kit logs the unreadable member');
    assert.equal((await rows()).length, 5);

    // An account row whose index who was lost while its agent still holds the profile: the same identity refreshes it,
    // with no list() before the sign-in.
    fake.signInAs({ accountId: 'canary-acct-f' });
    const f = await add();
    const lost = index();
    delete lost.accounts[f.id]!.who;
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(lost, null, 2) + '\n');
    fake.signInAs({ accountId: 'canary-acct-f', expires: later + 8 });
    const refreshedF = await add();
    assert.equal(refreshedF.id, f.id, 'the existing row takes the sign-in');
    assert.equal(index().accounts[f.id]!.who, whoOf('canary-acct-f'), 'and its who is recorded again');
    assert.equal((await ready(f.id)).expiresAt, later + 8);
    assert.equal((await rows()).length, 6);

    // The member row is the earliest holder of W; an account duplicate of W is discarded, and the newest sign-in's
    // credential is the one that survives on the member row.
    await kit.signOut('m1', 'openai');
    fake.signInAs({ accountId: 'canary-acct-w', expires: later + 9 });
    assert.equal((await add()).id, 'openai', 'the signed-out member takes W');
    await kit.signOut('m1', 'openai');
    fake.signInAs({ accountId: 'canary-acct-w', expires: later + 10 });
    const dupW = await add('openai');
    assert.equal(dupW.id, dupW.added, 'again on a signed-out member row adds an account row for W');
    assert.equal(index().accounts[dupW.id]!.who, whoOf('canary-acct-w'));
    assert.equal((await rows()).length, 7);
    fake.signInAs({ accountId: 'canary-acct-w', expires: later + 11 });
    assert.equal((await add()).id, 'openai', 'the newest sign-in stays on the member row');
    assert.equal(index().accounts[dupW.id], undefined, 'the account duplicate of W is discarded');
    assert.equal((await ready('openai')).expiresAt, later + 11, 'with the newest credential');
    assert.equal((await ready('openai')).who, whoOf('canary-acct-w'));
    assert.equal((await rows()).length, 6);

    // The member agent signs in again as another identity outside addAccount: its row follows the live profile, so the
    // next sign-in as that identity refreshes the member row instead of adding one.
    fake.signInAs({ accountId: 'canary-acct-h', expires: later + 12 });
    await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done;
    assert.equal((await add()).id, 'openai', 'the sign-in refreshes the member row');
    assert.equal(index().accounts.openai!.who, whoOf('canary-acct-h'), 'the member row follows its live profile');
    assert.equal((await ready('openai')).expiresAt, later + 12);
    assert.equal((await rows()).length, 6);

    // The roster cannot be read after the seal: the completed sign-in is kept as its own row, not discarded.
    armRosterRead = true;
    fake.signInAs({ accountId: 'canary-acct-r', expires: later + 13 });
    const logBeforeRoster = lines.length;
    const rosterKept = await add();
    assert.equal(rosterKept.id, rosterKept.added, 'the sign-in keeps its own row');
    assert.ok(lines.slice(logBeforeRoster).some((line) => line.includes('unreadable')), 'the kit logs it');
    assert.equal((await ready(rosterKept.id)).who, whoOf('canary-acct-r'));
    assert.equal((await ready(rosterKept.id)).expiresAt, later + 13);
    assert.equal((await rows()).length, 7);

    // The adopt reply is lost before the engine moves anything, and the sign-in's profile is gone from its agent by
    // another path: b did not receive it, so the sign-in keeps its own row and done does not name b.
    const bBefore = await ready(b.id);
    fake.signInAs({ accountId: 'canary-acct-b', expires: later + 14 });
    loseAdoptBeforeMove = true;
    const unmoved = await add();
    assert.equal(unmoved.id, unmoved.added, 'the sign-in keeps its own row');
    assert.equal(index().accounts[unmoved.added]!.who, whoOf('canary-acct-b'));
    assert.deepEqual(await ready(b.id), bBefore, 'b keeps its own credential');
    assert.equal((await rows()).length, 8);

    // No who or account id reaches the app: rows, views, done results, errors, kit state or log lines.
    await assert.rejects(kit.addAccount('m1', { authChoice: 'openai', again: 'openai.000000' }, () => {}), (error: Error) => { seen.push(error.message); return true; });
    const out = JSON.stringify([seen, lines, kit.state]);
    for (const id of ['a', 'b', 'e', 'f', 'h', 'q', 'r', 'w', 'y', 'z']) {
      assert.ok(!out.includes(whoOf(`canary-acct-${id}`)), `who of ${id} leaks`);
      assert.ok(!out.includes(`canary-acct-${id}`), `account id ${id} leaks`);
    }
    assert.ok(!readFileSync(indexOf(stateDir, 'm1'), 'utf8').includes('example.com'), 'the index holds no email');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// S8 (O14h): removeAccount and the orphan sweep. A member-agent account goes through authLogout with profileIds;
// an account agent through clear, an empty list, agents.delete with deleteFiles:false, removal of its state dir,
// then the entry. Removal is refused busy while live; the member stays ready. A late refresh racing clear is
// cleared again; a file written after removal is swept on the next prepare. A seal failure on a non-fresh add
// clears only that provider on the member agent.
test('removeAccount and the orphan sweep', async () => {
  const stateDir = scratchDir('o14h-remove');
  const fake = fakeGateway();
  const root = join(stateDir, 'openclaw');
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id).sort(), ['openai', second.id].sort());

    // Busy: a live run holds the agent's shared lock, so removal is refused and the member stays ready.
    fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 80 }]);
    fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 10 }]);
    for (const id of ['openai', second.id]) await kit.room('m1', id);
    const pending = kit.run({ member: 'm1', sessionKey: 'agent:m1:remove-busy', message: 'hello', account: second.id });
    while (!fake.calls.some((c) => c.method === 'agent'))
      await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(kit.removeAccount('m1', second.id), /busy/);
    assert.equal((await kit.accounts('m1')).find((a) => a.id === 'openai')?.state, 'ready', 'the member stays ready');
    assert.ok((await pending).ok, 'the live run finishes');

    // A refresh racing clear: after the first clear the engine lands one expired profile with no order; the removal
    // refuses with nothing deleted, and a retry clears it and drops the entry with no file left.
    let clears = 0;
    const racing: typeof fake.factory = (ctx) => {
      const transport = fake.factory(ctx);
      return { ...transport, request: async (method, params, o) => {
        const answer = await transport.request(method, params, o);
        if (method === 'byokit.accounts' && (params as { action?: string; agentId?: string }).action === 'clear'
          && (params as { agentId?: string }).agentId === agent && clears++ === 0)
          fake.refresh(agent, 'openai', { order: false, expires: Date.now() - 1_000 });
        return answer;
      } };
    };
    await kit.stop();
    const kit2 = new OpenClawKit({ stateDir, transport: racing, spawnEngine: false, callbackPort: 0 });
    try {
      await kit2.start();
      const deleteCalls = () => fake.calls.filter((c) => c.method === 'agents.delete');
      const deletesBefore = deleteCalls().length;
      await assert.rejects(kit2.removeAccount('m1', second.id), /still signing in/, 'a refresh that lands after clear refuses removal');
      assert.ok(second.id in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts, 'and keeps the entry');
      assert.equal(deleteCalls().length, deletesBefore, 'and deletes nothing');
      await kit2.removeAccount('m1', second.id);
      assert.ok(clears >= 1, 'clear raced a refresh');
      const deletes = deleteCalls().slice(deletesBefore);
      assert.equal(deletes.length, 1);
      assert.deepEqual((deletes[0]!.params as { deleteFiles?: boolean }).deleteFiles, false);
      assert.ok(!(await kit2.call('agents.list', {})).agents.some((a) => a.id === agent), 'the agent is gone');
      assert.ok(!(second.id in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts), 'and its entry');
      assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'and its state dir');
      assert.equal((await kit2.accounts('m1')).find((a) => a.id === 'openai')?.state, 'ready');

      // A file the engine lands after removal is swept on the next prepare.
      const late = join(root, 'state', 'agents', agent, 'agent', 'late.json');
      mkdirSync(join(late, '..'), { recursive: true });
      writeFileSync(late, '{}');
      await kit2.prepare();
      assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'the late file is swept on prepare');

      // The member-agent account goes through authLogout with its sealed profileIds, then the entry.
      const authCalls = () => fake.calls.filter((c) => c.method === 'models.authLogout');
      const authBefore = authCalls().length;
      await kit2.removeAccount('m1', 'openai');
      const auth = authCalls().slice(authBefore);
      assert.equal(auth.length, 1);
      const logout = auth[0]!.params as { provider?: string; agentId?: string; profileIds?: unknown };
      assert.equal(logout.provider, 'openai');
      assert.equal(logout.agentId, 'm1');
      assert.ok(Array.isArray(logout.profileIds) && logout.profileIds.length > 0, 'with its sealed profile');
      assert.ok(!('openai' in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts), 'the member entry is dropped');
    } finally { await kit2.stop(); }

    // A seal failure on a non-fresh add clears only that provider on the member agent: listing hides the
    // credential and runs cannot use it.
    let seals = 0;
    const failing: typeof fake.factory = (ctx) => {
      const transport = fake.factory(ctx);
      return { ...transport, request: async (method, params, o) => {
        if (method === 'byokit.accounts' && (params as { action?: string }).action === 'seal' && seals++ === 0)
          return { ok: false };
        return transport.request(method, params, o);
      } };
    };
    const kit3 = new OpenClawKit({ stateDir, transport: failing, spawnEngine: false, callbackPort: 0 });
    try {
      await kit3.start();
      await kit3.ensureMember('m2');
      const failed = await kit3.addAccount('m2', { authChoice: 'openai', via: 'browser' }, () => {});
      assert.equal((await failed.done).view.state, 'failed');
      const held = await kit3.callDynamic('byokit.accounts', { action: 'list', agentId: 'm2' }) as
        { ok: boolean; profiles: { provider: string }[] };
      assert.deepEqual(held.profiles.filter((p) => p.provider === 'openai'), [], 'the failed credential is cleared');
      assert.ok(!(await kit3.accounts('m2')).some((a) => a.id === 'openai'), 'listing hides it');
      const scoped = fake.calls.filter((c) => c.method === 'byokit.accounts'
        && (c.params as { action?: string; provider?: string }).action === 'clear'
        && (c.params as { agentId?: string }).agentId === 'm2');
      assert.ok(scoped.some((c) => (c.params as { provider?: string }).provider === 'openai'),
        'the member is cleared provider-scoped, not wiped');
    } finally { await kit3.stop(); }
  } finally {
    try { await kit.stop(); } catch { /* already stopped for the racing leg */ }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Fail closed (O14h): an index that cannot be parsed sweeps nothing, and a member-agent removal whose sign-in list
// cannot be read deletes no entry and logs out nothing.
test('an unreadable index sweeps nothing, and a removal whose list fails deletes nothing', async () => {
  const stateDir = scratchDir('o14h-fail-closed');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agentDir = join(stateDir, 'openclaw', 'state', 'agents', `m1--${second.id.slice('openai.'.length)}`);
    mkdirSync(join(agentDir, 'agent'), { recursive: true });
    writeFileSync(join(agentDir, 'agent', 'auth.json'), '{}');
    await kit.stop();

    const index = readFileSync(indexOf(stateDir, 'm1'), 'utf8');
    writeFileSync(indexOf(stateDir, 'm1'), '{');
    const kit2 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
    try {
      await kit2.prepare();
      assert.ok(existsSync(agentDir), 'the unreadable index keeps the account agent');
    } finally { await kit2.stop(); }

    writeFileSync(indexOf(stateDir, 'm1'), index);
    let listing = false;
    const failingList: typeof fake.factory = (ctx) => {
      const transport = fake.factory(ctx);
      return { ...transport, request: async (method, params, o) => {
        if (listing && method === 'byokit.accounts' && (params as { action?: string }).action === 'list') return { ok: false };
        return transport.request(method, params, o);
      } };
    };
    const kit3 = new OpenClawKit({ stateDir, transport: failingList, spawnEngine: false, callbackPort: 0 });
    try {
      await kit3.start();
      const logoutsBefore = fake.calls.filter((c) => c.method === 'models.authLogout').length;
      listing = true;
      await assert.rejects(kit3.removeAccount('m1', 'openai'), /could not be read/);
      listing = false;
      assert.equal(fake.calls.filter((c) => c.method === 'models.authLogout').length, logoutsBefore, 'nothing is logged out');
      assert.ok('openai' in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts, 'and the entry stays');
    } finally { await kit3.stop(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
