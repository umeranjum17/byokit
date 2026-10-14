// The account spine (docs/runtime-kits.md 5.15, O14 steps S5 and S6): a fake-gateway journey through the built
// kit that signs in, lists, renames, calls setDefaults, restarts and lists again, then adds a second ChatGPT
// account on its own sealed agent. Pass: expected rows, index mode 0600, clean canary scan.
// The S9 Auto input (O14i): models and room over the same journey, with the fake's cold usage cache (no usage
// on the first read). Pass: expected models and room.
// The S10 run (O14j): run({ account, model, needs }) on unbound keys. Pass: the account event comes first, Auto picks
// by room on the account's own agent and key, a resting end rests the account, a failed ready check and an empty pick
// end signed-out with no agent request, and a run with neither account nor needs is exactly the run it was.
// The S11 binding (O14k): a second run on one app key stays on the account that holds its session, pick equals the run's
// account event (unbound, bound to an account agent, bound to the member agent), a bound key refuses another id and an
// API-key conversation refuses 'auto' with no request but the binding read, an API-key run refuses a subscription- or
// member-bound conversation, and steer and abort reach the engine key. The key lane is indexed as `<provider>.key`
// (a new key replaces the old one, the key never reaches the index), so a key-held conversation stays bound and an
// API-billed binding continues on its lane account; a member-bound conversation holding no indexed account ends
// signed-out with plain words.
// The S12 move (O14l): kit.move forks the conversation onto the target account's agent and deletes the source. Pass: the
// user and tool rows are in the target, the source is gone, the next run on the app key continues there; busy while live
// (the kit's map, or the engine's hasActiveRun), start_failed with the source untouched, close_failed with both kept, and
// a move within one agent is ok with nothing forked.
import { mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Engine } from '../src/engine.ts';
import { hostKeySeal } from '../../secrets/src/index.ts';
import { OpenClawKit } from '../src/kit.ts';
import { memberOfAccount } from '../src/accounts.ts';
import { openclawLink } from '../src/link.ts';
import { openclawDevice } from '../src/device.ts';
import { words } from '../src/words.ts';
import type { DeviceLink, Grant, LinkStream } from '@byokit/pair';
import { createLocks } from '../src/locks.ts';
import { keyAgentId } from '../src/members.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import type { RunEvent, RunRef, SignInView } from '../src/types.ts';

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

test('a plan key: addAccount pastes the OpenCode Go key into typed activation and a run answers on it', async () => {
  const stateDir = scratchDir('go-plan-key');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  const secret = 'CANARY-GO-PLAN-KEY-5571';
  try {
    await kit.start();
    // Discovery offers the route as ready, and the engine sets it up only from a pasted key, never auth.start.
    assert.equal(kit.routes().find((r) => r.choice === 'opencode-go')?.readiness, 'ready');
    const views: SignInView[] = [];
    const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, (v) => views.push(v));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(views[0], { state: 'waiting', via: 'browser', prompt: 'Plan key' });
    added.paste(secret);
    const { view, id } = await added.done;
    assert.deepEqual(view, { state: 'done', via: 'browser' });
    assert.equal(id, 'opencode-go');
    assert.ok(!fake.calls.some((c) => c.method === 'openclaw.setup.auth.start'));
    assert.deepEqual(fake.calls.find((c) => c.method === 'openclaw.setup.activate')?.params,
      { agentId: 'm1', kind: 'api-key', authChoice: 'opencode-go', apiKey: '[redacted]' });
    const [row] = await kit.accounts('m1');
    assert.deepEqual({ id: row?.id, provider: row?.provider, billing: row?.billing, state: row?.state },
      { id: 'opencode-go', provider: 'opencode-go', billing: 'subscription', state: 'ready' });

    const texts: string[] = [];
    const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:go', message: 'Hello', model: 'opencode-go/fake-key-model' },
      (e) => { if (e.type === 'text') texts.push(e.text); });
    assert.ok(end.ok, JSON.stringify(end));
    assert.equal(texts.at(-1), 'fake: Hello');
    assert.ok(end.ok && end.usage?.total, 'the run reports usage');
    assert.ok(!JSON.stringify([views, end, fake.calls]).includes(secret));
    assert.ok(!readFileSync(indexOf(stateDir, 'm1'), 'utf8').includes(secret));

    // A choice the engine cannot set up is never ready, and the kit's sign-in for it fails with the engine's words.
    const refused = kit.routes().find((r) => r.choice === 'fal-api-key');
    assert.equal(refused?.readiness, 'no_upstream_flow');
    const failed = await kit.signIn('m1', { authChoice: 'fal-api-key' }, () => {});
    failed.paste(secret);
    assert.deepEqual(await failed.done, { state: 'failed', via: 'browser', why: 'failed',
      error: 'This key type is not available on this engine.' });
    const broken = await kit.signIn('m1', { authChoice: 'opencode-go' }, () => {});
    fake.failNext('openclaw.setup.activate', 'CANARY-ENGINE-ECHO');
    broken.paste('CANARY-GO-BROKEN');
    const brokenView = await broken.done;
    assert.deepEqual(brokenView, { state: 'failed', via: 'browser', why: 'failed', error: 'API key activation failed' });
    assert.ok(!JSON.stringify(brokenView).includes('CANARY-ENGINE-ECHO'));
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The pin writes config `auth` on a plan-key activation and restarts the gateway for it: the fake records the write
// and, when dropAfterMs is given, drops its connection then, so the kit's own closed() and reconnect run.
function activatingGateway(fake: ReturnType<typeof fakeGateway>, root: () => string, dropAfterMs?: number): typeof fake.factory {
  return (ctx) => {
    const inner = fake.factory(ctx);
    return { ...inner, request: async (method, params, options) => {
      const answer = await inner.request(method, params, options);
      if (method === 'openclaw.setup.activate') {
        const path = join(root(), 'openclaw.json');
        const config = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(path, JSON.stringify({ ...config, auth: { profiles: { 'opencode-go:default': { provider: 'opencode-go', mode: 'api_key' } } } }, null, 2));
        if (dropAfterMs !== undefined) setTimeout(() => fake.drop('gateway restart'), dropAfterMs);
      }
      return answer;
    } };
  };
}

test('a plan key add whose gateway restarts 11 s after activation is done, and its key is sealed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.method(Engine.prototype, 'start', async function (this: unknown) {
    const root = (this as { root: string }).root;
    mkdirSync(root, { recursive: true });
    if (!existsSync(join(root, 'openclaw.json'))) writeFileSync(join(root, 'openclaw.json'), '{}');
    return { port: 0, token: 'test', identityPath: '' };
  });
  t.mock.method(Engine.prototype, 'stop', async () => {});
  const stateDir = scratchDir('go-late-restart');
  const fake = fakeGateway();
  const kit: OpenClawKit = new OpenClawKit({ stateDir, transport: activatingGateway(fake, () => kit['engine'].root, 11_000), spawnEngine: true, callbackPort: 0 });
  try {
    await kit.start();
    const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    await flush();
    added.paste('CANARY-GO-LATE-RESTART');
    await flush();
    t.mock.timers.tick(11_000);
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    const { view, id } = await added.done;
    assert.deepEqual(view, { state: 'done', via: 'browser' });
    assert.equal(id, 'opencode-go');
    assert.ok(fake.calls.some((c) => c.method === 'byokit.accounts' && (c.params as { action?: string }).action === 'seal'));
    assert.equal(kit.state.phase, 'ready');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function spawnedEngine(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.method(Engine.prototype, 'start', async function (this: unknown) {
    const root = (this as { root: string }).root;
    mkdirSync(root, { recursive: true });
    if (!existsSync(join(root, 'openclaw.json'))) writeFileSync(join(root, 'openclaw.json'), '{}');
    return { port: 0, token: 'test', identityPath: '' };
  });
  t.mock.method(Engine.prototype, 'stop', async () => {});
}

const clears = (fake: ReturnType<typeof fakeGateway>, agentId: string) => fake.calls.filter((c) =>
  c.method === 'byokit.accounts' && (c.params as { action?: string; agentId?: string }).action === 'clear'
  && (c.params as { agentId?: string }).agentId === agentId).map((c) => (c.params as { provider?: string }).provider);

test('a plan key add whose gateway never restarts fails, is cleaned up, and keeps no row', async (t) => {
  spawnedEngine(t);
  const stateDir = scratchDir('go-no-restart');
  const fake = fakeGateway();
  const kit: OpenClawKit = new OpenClawKit({ stateDir, transport: activatingGateway(fake, () => kit['engine'].root), spawnEngine: true, callbackPort: 0 });
  try {
    await kit.start();
    const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    await flush();
    added.paste('CANARY-GO-NO-RESTART');
    await flush();
    t.mock.timers.tick(60_000);
    await flush();
    const { view } = await added.done;
    assert.deepEqual(view, { state: 'failed', via: 'browser', why: 'failed',
      error: 'The engine took too long to restart after this sign-in. Nothing was kept; try again.' });
    assert.deepEqual(clears(fake, 'm1'), ['opencode-go']);
    assert.ok(!(await kit.accounts('m1')).some((row) => row.id === 'opencode-go'));
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a plan key add cancelled after its activation is cancelled, cleaned up, and keeps the member\'s other sign-in', async (t) => {
  spawnedEngine(t);
  const stateDir = scratchDir('go-cancel-after-ok');
  const fake = fakeGateway();
  const kit: OpenClawKit = new OpenClawKit({ stateDir, transport: activatingGateway(fake, () => kit['engine'].root), spawnEngine: true, callbackPort: 0 });
  try {
    await kit.start();
    fake.seedProfile('m1', 'anthropic:default', { provider: 'anthropic', type: 'api_key' });
    const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    await flush();
    added.paste('CANARY-GO-CANCEL');
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    added.cancel();
    const { view } = await added.done;
    assert.equal(view.state, 'failed');
    assert.equal(view.why, 'declined');
    assert.deepEqual(clears(fake, 'm1'), ['opencode-go']);
    assert.ok(!(await kit.accounts('m1')).some((row) => row.id === 'opencode-go'));
    const left = await fake.transport.request('byokit.accounts', { action: 'list', agentId: 'm1' }) as { profiles: { provider: string }[] };
    assert.deepEqual(left.profiles.map((p) => p.provider), ['anthropic']);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a key add whose gateway restarts 10 s after activation is ok, and its key is sealed', async (t) => {
  spawnedEngine(t);
  const stateDir = scratchDir('key-late-restart');
  const fake = fakeGateway();
  const kit: OpenClawKit = new OpenClawKit({ stateDir, transport: activatingGateway(fake, () => kit['engine'].root, 10_000), spawnEngine: true, callbackPort: 0 });
  try {
    await kit.start();
    const pending = kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-KEY-LATE-RESTART' });
    await flush();
    t.mock.timers.tick(10_000);
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(await pending, { status: 'ok' });
    assert.ok(fake.calls.some((c) => c.method === 'byokit.keys' && (c.params as { action?: string }).action === 'seal'));
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a key add whose gateway never restarts returns retry and clears the key it activated', async (t) => {
  spawnedEngine(t);
  const stateDir = scratchDir('key-no-restart');
  const fake = fakeGateway();
  const kit: OpenClawKit = new OpenClawKit({ stateDir, transport: activatingGateway(fake, () => kit['engine'].root), spawnEngine: true, callbackPort: 0 });
  try {
    await kit.start();
    const pending = kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-KEY-NO-RESTART' });
    await flush();
    t.mock.timers.tick(60_000);
    await flush();
    assert.deepEqual(await pending, { status: 'retry', reason: 'busy' });
    assert.ok(!fake.calls.some((c) => c.method === 'byokit.keys' && (c.params as { action?: string }).action === 'seal'));
    assert.ok(fake.calls.some((c) => c.method === 'byokit.keys' && (c.params as { action?: string }).action === 'clear'));
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a key add that finds the gateway restarting before the engine saw the key returns retry and activates nothing', async (t) => {
  spawnedEngine(t);
  const stateDir = scratchDir('key-pre-accept');
  const fake = fakeGateway();
  const kit: OpenClawKit = new OpenClawKit({ stateDir, transport: activatingGateway(fake, () => kit['engine'].root), spawnEngine: true, callbackPort: 0 });
  try {
    await kit.start();
    fake.drop('gateway restart');
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-KEY-PRE-ACCEPT' }), { status: 'retry', reason: 'busy' });
    assert.ok(!fake.calls.some((c) => c.method === 'openclaw.setup.activate'));
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a plan key add cancelled while its activation is in flight is cleaned up only after the engine answers', async (t) => {
  spawnedEngine(t);
  const stateDir = scratchDir('go-cancel-in-flight');
  const fake = fakeGateway();
  let answer!: (value: object) => void;
  fake.handle('openclaw.setup.activate', () => new Promise((resolve) => { answer = resolve; }));
  const kit: OpenClawKit = new OpenClawKit({ stateDir, transport: activatingGateway(fake, () => kit['engine'].root), spawnEngine: true, callbackPort: 0 });
  try {
    await kit.start();
    const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    await flush();
    added.paste('CANARY-GO-IN-FLIGHT');
    await flush();
    added.cancel();
    await flush();
    assert.deepEqual(clears(fake, 'm1'), []);
    answer({ ok: true });
    const { view } = await added.done;
    assert.equal(view.why, 'declined');
    assert.deepEqual(clears(fake, 'm1'), ['opencode-go']);
    assert.ok(!(await kit.accounts('m1')).some((row) => row.id === 'opencode-go'));
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('overlapping plan key adds for one member take turns: a cancelled second add leaves the first sealed sign-in', async () => {
  const stateDir = scratchDir('go-overlap');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    const first = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    const second = kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    first.paste('CANARY-GO-FIRST');
    assert.deepEqual((await first.done).view, { state: 'done', via: 'browser' });
    const later = await second;
    later.paste('CANARY-GO-SECOND');
    later.cancel();
    assert.equal((await later.done).view.why, 'declined');
    assert.deepEqual((await kit.accounts('m1')).map((row) => row.id), ['opencode-go']);
    const left = await fake.transport.request('byokit.accounts', { action: 'list', agentId: 'm1' }) as { profiles: { provider: string }[] };
    assert.deepEqual(left.profiles.map((p) => p.provider), ['opencode-go']);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a key add whose gateway restart fails after activation returns retry, not a rejection', async (t) => {
  spawnedEngine(t);
  const stateDir = scratchDir('key-restart-fails');
  const fake = fakeGateway();
  let connects = 0;
  const transport = (ctx: Parameters<typeof fake.factory>[0]) => {
    if (connects++ > 0) throw new Error('restart refused');
    return activatingGateway(fake, () => kit['engine'].root, 1_000)(ctx);
  };
  const kit: OpenClawKit = new OpenClawKit({ stateDir, transport, spawnEngine: true, callbackPort: 0 });
  try {
    await kit.start();
    const pending = kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-KEY-RESTART-FAILS' });
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(await pending, { status: 'retry', reason: 'busy' });
    assert.ok(!fake.calls.some((c) => c.method === 'byokit.keys' && (c.params as { action?: string }).action === 'seal'));
    const probe = fake.factory({ port: 0, token: 'test', identityPath: '', bridgeSock: '' });
    assert.deepEqual(await probe.request('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a plan key add whose seal is refused shows the kit sentence, never the engine text', async () => {
  const stateDir = scratchDir('go-seal-refused');
  const fake = fakeGateway();
  const transport = (ctx: Parameters<typeof fake.factory>[0]) => {
    const inner = fake.factory(ctx);
    return { ...inner, request: async (method: string, params?: Record<string, unknown>, options?: Parameters<typeof inner.request>[2]) => {
      if (method === 'byokit.accounts' && params?.action === 'seal') throw new Error('CANARY-SEAL-ENGINE-TEXT');
      return inner.request(method, params, options);
    } };
  };
  const kit = new OpenClawKit({ stateDir, transport, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    added.paste('CANARY-GO-SEAL-REFUSED');
    assert.deepEqual((await added.done).view, { state: 'failed', via: 'browser', why: 'failed', error: 'Sign-in could not be saved. Try again.' });
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a key add for a choice the engine cannot set up is not_included and leaves the working key in place', async () => {
  const stateDir = scratchDir('key-not-included');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'sk-working' }), { status: 'ok' });
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'fal-api-key', apiKey: 'CANARY-KEY-FAL' }), { status: 'not_included', reason: 'model' });
    assert.equal((await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }) as { ok: boolean }).ok, true);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a key add whose activation throws clears the key it may have stored and reports retry', async () => {
  const stateDir = scratchDir('key-activate-throws');
  const fake = fakeGateway();
  fake.failNext('openclaw.setup.activate', 'activation timed out');
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-KEY-THROWS' }), { status: 'retry', reason: 'engine' });
    assert.ok(fake.calls.some((c) => c.method === 'byokit.keys' && (c.params as { action?: string }).action === 'clear'));
    assert.deepEqual(await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a key lane sealed before the index shipped is indexed by the start sweep and binds its conversations', async () => {
  const stateDir = scratchDir('key-lane-backfill');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'sk-before' }), { status: 'ok' });
  } finally {
    await kit.stop();
  }
  // The lane is sealed but its `openai.key` entry is gone, as a lane sealed before the index leaves it.
  const file = JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')) as { accounts: Record<string, unknown> };
  delete file.accounts['openai.key'];
  writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(file));
  const again = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await again.start();
    for (let i = 0; i < 200 && (await again.accounts('m1')).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual((await again.accounts('m1')).map((a) => [a.id, a.provider, a.billing, a.state]), [['openai.key', 'openai', 'api', 'ready']]);
    const paid = 'This conversation uses OpenAI API Key, which is billed per use. Choose OpenAI API Key to keep going.';
    const pick = await again.pick('m1', { account: 'auto' }, { sessionKey: `agent:${keyAgentId('m1')}:chat:k` });
    assert.ok(!pick.ok && pick.code === 'paid' && pick.reason === paid, JSON.stringify(pick));
  } finally {
    await again.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a multi-route key lane keeps its chosen route across a restart: route and label do not change', async () => {
  const stateDir = scratchDir('key-lane-multi-route');
  const fake = fakeGateway();
  const before = await (async () => {
    const first = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
    try {
      await first.start();
      assert.deepEqual(await first.addKey('m1', { authChoice: 'minimax-cn-api', apiKey: 'CANARY-MINIMAX-KEY' }), { status: 'ok' });
      return await first.accounts('m1');
    } finally {
      await first.stop();
    }
  })();
  assert.deepEqual(before.map((a) => [a.id, a.route, a.billing]), [['minimax.key', 'minimax-cn-api', 'api']]);
  const sweeps = () => fake.calls.filter((c) => c.method === 'byokit.keys' && (c.params as { action?: string }).action === 'ready').length;
  const from = sweeps();
  const again = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await again.start();
    for (let i = 0; i < 200 && sweeps() === from; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await again.accounts('m1'), before);
  } finally {
    await again.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a key lane whose index entry is missing is indexed again on the next connect of the same kit', async () => {
  const stateDir = scratchDir('key-lane-reconnect-index');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'sk-reconnect' }), { status: 'ok' });
    const file = JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')) as { accounts: Record<string, unknown> };
    delete file.accounts['openai.key'];
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(file));
    fake.drop('test');
    await kit.start();
    for (let i = 0; i < 200 && (await kit.accounts('m1')).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual((await kit.accounts('m1')).map((a) => [a.id, a.billing, a.state]), [['openai.key', 'api', 'ready']]);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an API-billed legacy account binding continues on its own agent and session; steer and abort reach it', async () => {
  const stateDir = scratchDir('o14-legacy-api-binding');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    const session = 'agent:m1:chat:legacy';
    assert.ok((await kit.run({ member: 'm1', sessionKey: session, account: second.id, message: 'hello' })).ok);
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'sk-legacy' }), { status: 'ok' });
    const file = JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')) as { accounts: Record<string, { route: string }> };
    file.accounts[second.id]!.route = 'openai-api-key';
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(file));

    const from = fake.calls.length;
    assert.ok((await kit.run({ member: 'm1', sessionKey: session, message: 'again', auth: 'apiKey' })).ok);
    const ran = fake.calls.slice(from).filter((c) => c.method === 'agent').map((c) => c.params as { agentId: string; sessionKey: string });
    assert.deepEqual(ran.map((p) => [p.agentId, p.sessionKey]), [[agent, `agent:${agent}:chat:legacy`]]);

    await kit.steer(session, 'and more', { auth: 'apiKey' });
    await kit.abort(session, { auth: 'apiKey' });
    assert.deepEqual(fake.calls.filter((c) => c.method === 'sessions.steer' || c.method === 'chat.abort')
      .slice(-2).map((c) => [c.method, (c.params as { sessionKey: string }).sessionKey]),
      [['sessions.steer', `agent:${agent}:chat:legacy`], ['chat.abort', `agent:${agent}:chat:legacy`]]);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('session binding: a run stays on the account that holds its session; pick equals the run; bound and paid refuse', async () => {
  const stateDir = scratchDir('o14k-binding');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    const names = Object.fromEntries((await kit.accounts('m1')).map((a) => [a.id, a.name]));
    const roomy = async (member: number, account: number) => {
      fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 100 - member }]);
      fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 100 - account }]);
      for (const id of ['openai', second.id]) await kit.room('m1', id);
    };
    const agentCalls = () => fake.calls.filter((c) => c.method === 'agent');
    const run = async (spec: { sessionKey: string; account?: string }) => {
      const events: RunEvent[] = [];
      const before = agentCalls().length;
      const end = await kit.run({ member: 'm1', message: 'hello', ...spec }, (e) => events.push(e));
      return { end, events, requests: agentCalls().slice(before).map((c) => c.params as { agentId: string; sessionKey: string }) };
    };
    // `pick` with the key equals the run's account event on the same state, `considered` included.
    const same = async (sessionKey: string, account: string) => {
      const pick = await kit.pick('m1', { account }, { sessionKey });
      const ran = await run({ sessionKey, account });
      const event = ran.events[0];
      assert.ok(pick.ok && event?.type === 'account', JSON.stringify([pick, ran.events]));
      assert.deepEqual({ account: pick.account.id, model: pick.model, how: pick.how, why: pick.why, considered: pick.considered },
        { account: event.account, model: event.model, how: event.how, why: event.why, considered: event.considered });
      return ran;
    };
    // A refusal: run ends `other` with the pick's words and no event. Its only gateway requests are the binding read's
    // and the account listing's: no room, model, sign-in or agent request follows them.
    const refuses = async (sessionKey: string, account: string | undefined, code: 'bound' | 'paid', message: string) => {
      const from = fake.calls.length;
      const pick = await kit.pick('m1', { account: account ?? 'default' }, { sessionKey });
      assert.ok(!pick.ok && pick.code === code && pick.reason === message, JSON.stringify(pick));
      const events: RunEvent[] = [];
      const end = await kit.run({ member: 'm1', message: 'hello', sessionKey, ...(account !== undefined ? { account } : {}) }, (e) => events.push(e));
      assert.deepEqual([end, events], [{ ok: false, kind: 'other', message }, []]);
      const listing = (c: { method: string; params: unknown }) => c.method === 'agents.list' || c.method === 'sessions.resolve'
        || (c.method === 'byokit.accounts' && (c.params as { action?: string }).action === 'list');
      const reads = fake.calls.slice(from).filter((c) => !listing(c)).map((c) => c.method);
      assert.deepEqual(reads, []);
    };

    // Unbound: Auto takes the account with the most room, on its own agent under the app key's tail.
    await roomy(20, 90);
    const first = await same('agent:m1:chat:1', 'auto');
    assert.deepEqual(first.requests.map((r) => [r.agentId, r.sessionKey]), [[agent, `agent:${agent}:chat:1`]]);

    // Bound to the member agent: Auto chooses only among its accounts, though the account agent has more room.
    const memberRun = await run({ sessionKey: 'agent:m1:chat:m', account: 'openai' });
    assert.deepEqual(memberRun.requests.map((r) => r.agentId), ['m1']);
    const onMember = await same('agent:m1:chat:m', 'auto');
    assert.deepEqual(onMember.requests.map((r) => [r.agentId, r.sessionKey]), [['m1', 'agent:m1:chat:m']]);
    assert.ok(onMember.events[0]?.type === 'account' && onMember.events[0].account === 'openai'
      && onMember.events[0].considered.find((r) => r.id === second.id)?.out === 'bound', JSON.stringify(onMember.events[0]));
    await refuses('agent:m1:chat:m', second.id, 'bound', `This conversation uses ${names.openai}. Move it to switch accounts.`);

    // The member account now has the most room, yet a second run on chat:1 stays on the account agent that holds it,
    // with no account named, with 'auto', and by its engine key; pick agrees.
    await roomy(90, 20);
    const again = await run({ sessionKey: 'agent:m1:chat:1' });
    assert.ok(again.events[0]?.type === 'account' && again.events[0].account === second.id && again.events[0].how === 'chosen', JSON.stringify(again.events));
    assert.ok(again.end.ok && again.end.account === second.id);
    const bound = await same('agent:m1:chat:1', 'auto');
    assert.deepEqual(bound.requests.map((r) => [r.agentId, r.sessionKey]), [[agent, `agent:${agent}:chat:1`]]);
    const byEngineKey = await same(`agent:${agent}:chat:1`, 'auto');
    assert.deepEqual(byEngineKey.requests.map((r) => [r.agentId, r.sessionKey]), [[agent, `agent:${agent}:chat:1`]]);
    await refuses('agent:m1:chat:1', 'openai', 'bound', `This conversation uses ${names[second.id]}. Move it to switch accounts.`);
    // An unknown id is still a caller bug, and a key of an agent the index does not name is not the member's.
    await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:1', message: 'hi', account: 'openai.ffffff' }), /unknown account/);
    await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m1--abcdef:chat:1', message: 'hi' }), /not a session of member/);
    await assert.rejects(kit.pick('m1', { account: 'auto' }, { sessionKey: 'agent:m2:chat:1' }), /not a session of member/);

    // Steer and abort with the app key reach the live run's engine key.
    const aborted = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:1', message: 'hello' }, (e) => {
      if (e.type === 'started') void kit.steer('agent:m1:chat:1', 'and more').then(() => kit.abort('agent:m1:chat:1'));
    });
    assert.deepEqual(aborted, { ok: false, aborted: true });
    assert.deepEqual(fake.calls.filter((c) => c.method === 'sessions.steer' || c.method === 'chat.abort').map((c) => [c.method, (c.params as { sessionKey: string }).sessionKey]),
      [['sessions.steer', `agent:${agent}:chat:1`], ['chat.abort', `agent:${agent}:chat:1`]]);

    // An API-key conversation: only its own id continues it; 'auto', 'default', no account and another id refuse.
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'sk-test' }), { status: 'ok' });
    const laneAgent = keyAgentId('m1');
    // The lane is indexed once as `<provider>.key`, replacing nothing else; the key itself never reaches the index.
    const laneText = readFileSync(indexOf(stateDir, 'm1'), 'utf8');
    assert.ok(!laneText.includes('sk-test'), 'the key never reaches the index');
    const laneEntry = (JSON.parse(laneText) as { accounts: Record<string, Record<string, unknown>> }).accounts['openai.key'];
    assert.equal(laneEntry?.agent, laneAgent);
    assert.equal(laneEntry?.route, 'openai-api-key');
    assert.ok(typeof laneEntry?.addedAt === 'number');
    const laneRow = (await kit.accounts('m1')).find((a) => a.id === 'openai.key');
    assert.deepEqual([laneRow?.provider, laneRow?.billing, laneRow?.state], ['openai', 'api', 'ready']);
    const keyed = await same('agent:m1:chat:k', 'openai.key');
    assert.deepEqual(keyed.requests.map((r) => [r.agentId, r.sessionKey]), [[laneAgent, `agent:${laneAgent}:chat:k`]]);
    const paid = 'This conversation uses OpenAI API Key, which is billed per use. Choose OpenAI API Key to keep going.';
    for (const account of ['auto', 'default', undefined, 'openai']) await refuses('agent:m1:chat:k', account, 'paid', paid);
    const kept = await run({ sessionKey: 'agent:m1:chat:k', account: 'openai.key' });
    assert.ok(kept.end.ok && kept.end.account === 'openai.key', JSON.stringify(kept.end));
    assert.deepEqual(kept.requests.map((r) => [r.agentId, r.sessionKey]), [[laneAgent, `agent:${laneAgent}:chat:k`]]);
    // An API-key run continues only an API-billed conversation: a subscription- or member-bound one is refused, with no agent request.
    const keyRun =(sessionKey: string) => kit.run({ member: 'm1', sessionKey, message: 'hello', auth: 'apiKey' });
    const keyRefusal = (name: string) => ({ ok: false, kind: 'other', message: `This conversation uses ${name}. Move it to switch accounts.` });
    const keyFrom = fake.calls.length;
    assert.deepEqual(await keyRun('agent:m1:chat:1'), keyRefusal(names[second.id]!));
    assert.deepEqual(await keyRun('agent:m1:chat:m'), keyRefusal(names.openai!));
    assert.deepEqual(fake.calls.slice(keyFrom).filter((c) => c.method === 'agent'), []);
    // An API-billed binding continues on its indexed lane account, on the same session: no split history.
    // An unbound key starts there too.
    assert.ok((await keyRun('agent:m1:chat:k')).ok);
    assert.ok((await keyRun('agent:m1:chat:new')).ok);
    assert.deepEqual(agentCalls().slice(-2).map((c) => { const p = c.params as { agentId: string; sessionKey: string }; return [p.agentId, p.sessionKey]; }),
      [[laneAgent, `agent:${laneAgent}:chat:k`], [laneAgent, `agent:${laneAgent}:chat:new`]]);
    // A new key replaces the old one on the same lane: no `<member>--<hex6>` agent per later key.
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'apiKey', apiKey: 'sk-test-2' }), { status: 'ok' });
    const replaced = (JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')) as { accounts: Record<string, { agent: string }> }).accounts;
    assert.deepEqual(Object.keys(replaced).filter((id) => replaced[id]!.agent === laneAgent), ['anthropic.key']);
    const roster = (await kit.call('agents.list', {}) as { agents: { id: string }[] }).agents.map((a) => a.id);
    assert.ok(!roster.some((id) => id.startsWith('m1--') && id !== agent), 'no account agent per later key');
    assert.ok((await keyRun('agent:m1:chat:k2')).ok, 'the replacement key runs');
    const scanned = JSON.stringify([readFileSync(indexOf(stateDir, 'm1'), 'utf8'), await kit.accounts('m1')]);
    for (const canary of ['sk-test', 'sk-test-2']) assert.ok(!scanned.includes(canary), `the index leaks ${canary}`);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('session binding: a member-bound conversation that holds no account names another account', async () => {
  const stateDir = scratchDir('o14k-unnamed');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    // m2's conversation lives on its member agent, which holds no account: its only account is on an account agent.
    await kit.run({ member: 'm2', sessionKey: 'agent:m2:chat:y', message: 'hello' });
    await kit.call('agents.create', { name: 'm2--abcdef', workspace: join(stateDir, 'openclaw', 'workspaces', 'm2') });
    mkdirSync(join(stateDir, 'openclaw', 'accounts'), { recursive: true });
    writeFileSync(indexOf(stateDir, 'm2'), JSON.stringify({ v: 1, accounts: { 'openai.abcdef': { agent: 'm2--abcdef', name: 'Work', route: 'openai', addedAt: 1 } }, defaults: {} }, null, 2) + '\n');
    const from = fake.calls.length;
    const end = await kit.run({ member: 'm2', sessionKey: 'agent:m2:chat:y', message: 'hello', account: 'openai.abcdef' });
    assert.deepEqual(end, { ok: false, kind: 'other', message: 'This conversation uses another account. Move it to switch accounts.' });
    assert.deepEqual(fake.calls.slice(from).filter((c) => c.method === 'agent'), []);
    // With 'auto' or 'default' the same conversation ends signed-out, with plain words: its member agent holds
    // no indexed account, so naming the signed-in provider would mislead. Pick agrees.
    const plain = 'No account in this conversation is signed in.';
    for (const account of ['auto', 'default'] as const) {
      const auto = await kit.run({ member: 'm2', sessionKey: 'agent:m2:chat:y', message: 'hello', account });
      assert.deepEqual(auto, { ok: false, kind: 'signed-out', message: plain });
    }
    assert.deepEqual(await kit.pick('m2', { account: 'auto' }, { sessionKey: 'agent:m2:chat:y' }),
      { ok: false, code: 'none', reason: plain,
        considered: [{ id: 'openai.abcdef', left: 'unknown', age: 'unknown', confidence: 'unknown', reason: 'bound', out: 'bound' }] });
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('session binding: a member-bound refusal on a cold index names the member account, with no agent request', async () => {
  const stateDir = scratchDir('o14k-cold');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m3', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    await kit.run({ member: 'm3', sessionKey: 'agent:m3:chat:y', message: 'hello' });
    await kit.call('agents.create', { name: 'm3--abcdef', workspace: join(stateDir, 'openclaw', 'workspaces', 'm3') });
    // The index names only an account agent, so the member's own account is not listed yet: the index is cold for it.
    mkdirSync(join(stateDir, "openclaw", "accounts"), { recursive: true });
    writeFileSync(indexOf(stateDir, 'm3'), JSON.stringify({ v: 1, accounts: { 'openai.abcdef': { agent: 'm3--abcdef', name: 'Work', route: 'openai', addedAt: 1 } }, defaults: {} }, null, 2) + '\n');
    const from = fake.calls.length;
    const end = await kit.run({ member: 'm3', sessionKey: 'agent:m3:chat:y', message: 'hello', account: 'openai.abcdef' });
    assert.deepEqual(fake.calls.slice(from).filter((c) => c.method === 'agent'), []);
    const names = Object.fromEntries((await kit.accounts('m3')).map((a) => [a.id, a.name]));
    assert.deepEqual(end, { ok: false, kind: 'other', message: `This conversation uses ${names.openai}. Move it to switch accounts.` });
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('move: the transcript forks onto the target and the source goes; busy, start_failed, close_failed, same agent', async () => {
  const stateDir = scratchDir('o14l-move');
  const fake = fakeGateway();
  // The app tool holds its call open until `release`, so a run stays live for as long as a leg needs.
  let release: () => void = () => {};
  let hold = Promise.resolve();
  let entered: () => void = () => {};
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0,
    tools: [{ name: 'report', description: 'record progress', parameters: { type: 'object' } }],
    host: { gate: async () => ({ allow: true }), call: async (_run: RunRef, _tool: string, input: Record<string, unknown>) => {
      entered();
      await hold;
      return `Progress: ${String(input.text)}`;
    } } });
  const history = async (sessionKey: string) =>
    (await kit.call('chat.history', { sessionKey }) as { messages: { role: string; toolName?: string; content: { text?: string }[] }[] }).messages;
  const resolves = async (agentId: string, tail: string) =>
    (await kit.call('sessions.resolve', { key: `agent:${agentId}:${tail}`, agentId, allowMissing: true }) as { ok?: boolean }).ok === true;
  const sent = (from: number, ...methods: string[]) => fake.calls.slice(from).filter((c) => methods.includes(c.method));
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', name: 'Personal' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    const ref = { member: 'm1', sessionKey: 'agent:m1:chat:1' };

    // A conversation on the member account with a tool call: its user, tool call, tool result and reply rows.
    assert.ok((await kit.run({ ...ref, message: '[tool report {"text":"Working"}]', account: 'openai' })).ok);
    const before = await history('agent:m1:chat:1');
    assert.deepEqual(before.map((r) => r.role), ['user', 'assistant', 'toolResult', 'assistant']);

    const { sessions: [source] } = await kit.call('sessions.list', { agentId: 'm1', search: 'agent:m1:chat:1' }) as
      { sessions: { sessionId: string; updatedAt: number }[] };
    const from = fake.calls.length;
    assert.deepEqual(await kit.move(ref, second.id), { ok: true, session: `agent:${agent}:chat:1` });
    // One fork into the target (never chat.history plus chat.inject), then the source's delete if it is still the one read.
    assert.deepEqual(sent(from, 'chat.history', 'chat.inject', 'sessions.create', 'sessions.delete').map((c) => [c.method, c.params]), [
      ['sessions.create', { agentId: agent, key: `agent:${agent}:chat:1`, parentSessionKey: 'agent:m1:chat:1', fork: true, model: 'openai/default' }],
      ['sessions.delete', { key: 'agent:m1:chat:1', agentId: 'm1', deleteTranscript: true,
        expectedSessionId: source!.sessionId, expectedSessionUpdatedAt: source!.updatedAt }],
    ]);
    const target = await history(`agent:${agent}:chat:1`);
    assert.deepEqual(target, before, 'the user and tool rows are in the target');
    assert.ok(target.some((r) => r.role === 'toolResult' && r.toolName === 'report' && r.content[0]?.text === 'Progress: Working'));
    assert.equal(await resolves('m1', 'chat:1'), false, 'the source session is gone');

    // The next run on the app key continues on the target, after the full transcript.
    const events: RunEvent[] = [];
    const next = await kit.run({ ...ref, message: 'and then' }, (e) => events.push(e));
    assert.ok(next.ok && next.account === second.id, JSON.stringify(next));
    assert.ok(events[0]?.type === 'account' && events[0].sessionKey === `agent:${agent}:chat:1`, JSON.stringify(events[0]));
    assert.deepEqual((await history(`agent:${agent}:chat:1`)).map((r) => r.role), ['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant']);

    // Busy while live, before any lock: chat:1 by the kit's own map, chat:2 (a run on the member agent the map does not
    // hold) by the engine's hasActiveRun. Nothing is forked or deleted.
    hold = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const both = new Promise<void>((resolve) => { entered = () => { if (++calls === 2) resolve(); }; });
    const live = [kit.run({ ...ref, message: '[tool report {"text":"a"}]' }),
      kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:2', message: '[tool report {"text":"b"}]' })];
    await both;
    const busy = { ok: false, code: 'busy', message: 'Wait for this conversation to finish before moving it.' };
    const busyFrom = fake.calls.length;
    assert.deepEqual(await kit.move(ref, 'openai'), busy);
    assert.deepEqual(await kit.move({ member: 'm1', sessionKey: 'agent:m1:chat:2' }, second.id), busy);
    assert.deepEqual(sent(busyFrom, 'sessions.create', 'sessions.delete'), []);
    release();
    for (const end of await Promise.all(live)) assert.ok(end.ok, JSON.stringify(end));
    assert.equal(sent(busyFrom, 'sessions.list').length, 2, 'each busy answer came from the read before any lock');

    // The engine refuses the fork: start_failed with its message cut to 200 characters, the source untouched.
    fake.failNext('sessions.create', `Parent session is too large to fork ${'x'.repeat(300)}`);
    const kept = await history(`agent:${agent}:chat:1`);
    const refusedFrom = fake.calls.length;
    const refused = await kit.move(ref, 'openai');
    assert.ok(!refused.ok && refused.code === 'start_failed' && refused.message.length === 200
      && refused.message.startsWith('Parent session is too large to fork') && refused.live === undefined, JSON.stringify(refused));
    assert.deepEqual(sent(refusedFrom, 'sessions.delete'), []);
    assert.deepEqual(await history(`agent:${agent}:chat:1`), kept, 'the source is untouched');

    // The source changed before its delete: close_failed, the new key live and both sessions kept.
    fake.failNext('sessions.delete', 'Session agent:m1--x:chat:1 changed before deletion. Retry.');
    assert.deepEqual(await kit.move(ref, 'openai'), { ok: false, code: 'close_failed', live: 'agent:m1:chat:1',
      message: `This conversation now continues on ${(await kit.accounts('m1')).find((a) => a.id === 'openai')!.name}, but its earlier copy could not be removed.` });
    assert.deepEqual([await resolves(agent, 'chat:1'), await resolves('m1', 'chat:1')], [true, true]);

    // Within one agent (the member agent's two accounts): ok on its own key, nothing forked or deleted.
    await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: 'm1', authChoice: 'apiKey', apiKey: 'sk-test' });
    assert.ok((await kit.accounts('m1')).some((a) => a.id === 'anthropic' && a.state === 'ready'));
    const sameFrom = fake.calls.length;
    assert.deepEqual(await kit.move(ref, 'anthropic'), { ok: true, session: 'agent:m1:chat:1' });
    assert.deepEqual(sent(sameFrom, 'sessions.create', 'sessions.delete'), []);

    // A target that is not ready: start_failed before any fork, the source untouched.
    await kit.callDynamic('byokit.accounts', { action: 'clear', agentId: agent });
    const unready = fake.calls.length;
    assert.deepEqual(await kit.move(ref, second.id), { ok: false, code: 'start_failed', message: 'Sign in to Personal first.' });
    assert.deepEqual(sent(unready, 'sessions.create', 'sessions.delete'), []);
    assert.equal(await resolves('m1', 'chat:1'), true);

    // A conversation never started is unsupported; another member's key and an unknown account are caller bugs.
    assert.deepEqual(await kit.move({ member: 'm1', sessionKey: 'agent:m1:chat:none' }, 'openai'),
      { ok: false, code: 'unsupported', message: 'This conversation has not started yet, so there is nothing to move.' });
    await assert.rejects(kit.move({ member: 'm1', sessionKey: 'agent:m2:chat:1' }, 'openai'), /not a session of member/);
    await assert.rejects(kit.move(ref, 'openai.ffffff'), /unknown account/);

    // With no account agent the binding asks nothing: the member agent's own conversation still moves within it.
    assert.deepEqual(await kit.signIn('m2', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    assert.ok((await kit.run({ member: 'm2', sessionKey: 'agent:m2:chat:1', message: 'hello' })).ok);
    await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: 'm2', authChoice: 'apiKey', apiKey: 'sk-test' });
    assert.deepEqual(await kit.move({ member: 'm2', sessionKey: 'agent:m2:chat:1' }, 'anthropic'), { ok: true, session: 'agent:m2:chat:1' });
    assert.equal((await kit.move({ member: 'm2', sessionKey: 'agent:m2:chat:none' }, 'anthropic') as { code?: string }).code, 'unsupported');
  } finally {
    release();
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
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const pending = kit.run({ member: 'm1', sessionKey: 'agent:m1:remove-busy', message: 'hello', account: second.id },
      (e) => { if (e.type === 'started') started(); });
    await running;
    await assert.rejects(kit.removeAccount('m1', second.id), /removeAccount: busy/);
    assert.ok(second.id in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts, 'a busy refusal keeps the entry');
    assert.ok((await kit.call('agents.list', {})).agents.some((a) => a.id === agent), 'and the account agent');
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

test('move: a run that waited across a move binds again and ends moved; a taken target key refuses the move', async () => {
  const stateDir = scratchDir('o14l-move-race');
  const fake = fakeGateway();
  let release: () => void = () => {};
  let hold = Promise.resolve();
  let entered: () => void = () => {};
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0,
    tools: [{ name: 'report', description: 'record progress', parameters: { type: 'object' } }],
    host: { gate: async () => ({ allow: true }), call: async (_run: RunRef, _tool: string, input: Record<string, unknown>) => {
      entered();
      await hold;
      return `Progress: ${String(input.text)}`;
    } } });
  const resolves = async (agentId: string, tail: string) =>
    (await kit.call('sessions.resolve', { key: `agent:${agentId}:${tail}`, agentId, allowMissing: true }) as { ok?: boolean }).ok === true;
  const sent = (from: number, ...methods: string[]) => fake.calls.slice(from).filter((c) => methods.includes(c.method));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 2000 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(done());
  };
  const resolved = (from: number, key: string) => () =>
    sent(from, 'sessions.resolve').some((c) => (c.params as { key?: string }).key === key);
  const moved = { ok: false, kind: 'other', message: 'This conversation just moved to another account. Send it again to continue there.' };
  // A live tool run on `agent` holds its shared lock, so a move onto it holds its source and waits there.
  const holdOn = async (account: string) => {
    hold = new Promise((resolve) => { release = resolve; });
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const run = kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:hold', message: '[tool report {"text":"hold"}]', account });
    await inside;
    return { run }; // wrapped: awaiting holdOn must not wait for the run's end
  };
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    const added = [];
    for (const name of ['Personal', 'Work']) {
      const a = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser', name }, () => {});
      assert.equal((await a.done).view.state, 'done');
      added.push({ id: a.id, agent: `m1--${a.id.slice('openai.'.length)}` });
    }
    // Locks are taken in id order: the move holds `low` and waits for `high`.
    const [low, high] = added.sort((a, b) => a.agent.localeCompare(b.agent));

    // Account path: chat:1 lives on `low`; a run on it binds there, then waits for `low` while the move holds it.
    assert.ok((await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:1', message: 'hi', account: low!.id })).ok);
    let { run: holder } = await holdOn(high!.id);
    let mark = fake.calls.length;
    const accountMove = kit.move({ member: 'm1', sessionKey: 'agent:m1:chat:1' }, high!.id);
    await until(() => sent(mark, 'sessions.list').length === 1);
    mark = fake.calls.length;
    const events: RunEvent[] = [];
    const waited = kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:1', message: 'again' }, (e) => events.push(e));
    await until(resolved(mark, `agent:${low!.agent}:chat:1`));
    release();
    assert.ok((await holder).ok);
    assert.deepEqual(await accountMove, { ok: true, session: `agent:${high!.agent}:chat:1` });
    assert.deepEqual(await waited, moved);
    assert.deepEqual(events, [], 'no event before the moved end');
    assert.equal(await resolves(low!.agent, 'chat:1'), false, 'the deleted key is not run on again');
    const retried = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:1', message: 'again' });
    assert.ok(retried.ok && retried.account === high!.id, JSON.stringify(retried));

    // Member path: chat:2 lives on the member agent; a run on it waits for the member agent's lock across the move.
    assert.ok((await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:2', message: 'hi' })).ok);
    ({ run: holder } = await holdOn(high!.id));
    mark = fake.calls.length;
    const memberMove = kit.move({ member: 'm1', sessionKey: 'agent:m1:chat:2' }, high!.id);
    await until(() => sent(mark, 'sessions.list').length === 1);
    mark = fake.calls.length;
    const memberRun = kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:2', message: 'again' });
    await until(resolved(mark, 'agent:m1:chat:2'));
    release();
    assert.ok((await holder).ok);
    assert.deepEqual(await memberMove, { ok: true, session: `agent:${high!.agent}:chat:2` });
    assert.deepEqual(await memberRun, moved);
    assert.equal(await resolves('m1', 'chat:2'), false, 'the deleted key is not run on again');
    const memberRetry = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:2', message: 'again' });
    assert.ok(memberRetry.ok && memberRetry.account === high!.id, JSON.stringify(memberRetry));

    // A session already under the target key: start_failed, nothing forked or deleted, the source untouched.
    assert.ok((await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat:3', message: 'hi' })).ok);
    await kit.call('sessions.create', { agentId: low!.agent, key: `agent:${low!.agent}:chat:3` });
    mark = fake.calls.length;
    assert.deepEqual(await kit.move({ member: 'm1', sessionKey: 'agent:m1:chat:3' }, low!.id), { ok: false, code: 'start_failed',
      message: `${(await kit.accounts('m1')).find((a) => a.id === low!.id)!.name} already holds a conversation under this name, so nothing was moved.` });
    assert.deepEqual(sent(mark, 'sessions.create', 'sessions.delete'), []);
    assert.equal(await resolves('m1', 'chat:3'), true);
  } finally {
    release();
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// O14m attribution: an unreadable or malformed account index attributes nothing and never throws out of the link filter,
// approvals or bridge.
test('attribution: a malformed account index maps nothing and does not throw', () => {
  const root = scratchDir('o14m-malformed-index');
  try {
    mkdirSync(join(root, 'accounts'), { recursive: true });
    writeFileSync(join(root, 'accounts', 'm1.json'), '{not json');
    assert.equal(memberOfAccount(root, 'm1--abcdef'), undefined);
    assert.equal(memberOfAccount(root, 'agent:m1--abcdef:x'), undefined);
    assert.equal(memberOfAccount(root, 'm1'), 'm1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attribution: a legacy member with its own workspace attributes to itself, an orphan account agent does not', () => {
  const root = scratchDir('o14m-legacy-member');
  try {
    mkdirSync(join(root, 'workspaces', 'work--c0ffee'), { recursive: true });
    assert.equal(memberOfAccount(root, 'work--c0ffee'), 'work--c0ffee');
    assert.equal(memberOfAccount(root, 'agent:work--c0ffee:x'), 'work--c0ffee');
    assert.equal(memberOfAccount(root, 'work--ffffff'), undefined);
    assert.equal(memberOfAccount(root, 'agent:work--ffffff:x'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// O14m attribution and link frames: an approval raised on an indexed `<member>--<hex6>` agent lists under the
// member, link `oc.events`/`oc.sessions` carry the account agent under the member, `oc.run` carries the account
// selection with the account frame first on the host and on a stub device link, an unindexed account-shaped agent
// stays unreachable across events, sessions, approvals and steer/abort, `addAccount` refuses key material, and a canary held by two accounts never
// appears in a link frame.
test('attribution and link frames: account agent under the member, unindexed unreachable, key refused, canary scan', async () => {
  const stateDir = scratchDir('o14m-attribution');
  const fake = fakeGateway();
  const canaryWho = 'c0ffee1234567890';
  let maskWho = false;
  const masking: typeof fake.factory = (ctx) => {
    const transport = fake.factory(ctx);
    return { ...transport, request: async (method, params, o) => {
      const answer = await transport.request(method, params, o);
      const p = params as { action?: string; agentId?: string } | undefined;
      if (maskWho && method === 'byokit.accounts' && p?.action === 'list'
        && (p.agentId === 'm1' || p.agentId?.startsWith('m1--')))
        return { ...(answer as Record<string, unknown>),
          profiles: ((answer as { profiles?: Record<string, unknown>[] }).profiles ?? [])
            .map((profile) => ({ ...profile, who: canaryWho })) };
      return answer;
    } };
  };
  const kit = new OpenClawKit({ stateDir, transport: masking, spawnEngine: false, callbackPort: 0 });
  const frames: string[] = [];
  const snap = (v: unknown): void => { frames.push(JSON.stringify(v)); };
  try {
    await kit.start();
    fake.signInAs({ accountId: 'canary-o14m-shared', email: 'umer@example.com' });
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    fake.signInAs({ accountId: 'canary-o14m-other', email: 'umer@example.com' });
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;

    // Attribution: an approval raised on the account agent lists under the member.
    await kit.call('exec.approval.request', { id: 'o14m-a1', command: 'tune antenna', agentId: agent, sessionKey: `agent:${agent}:x` });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(kit.approvals('m1').some((a) => a.id === 'o14m-a1' && a.member === 'm1'));
    assert.deepEqual(kit.approvals('m2'), []);

    // An unindexed `<member>--<hex6>` agent is never listed and stays unreachable.
    await kit.call('agents.create', { name: 'm1--ffffff', workspace: join(stateDir, 'openclaw', 'workspaces', 'm1') });
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id).sort(), ['openai', second.id].sort());
    await assert.rejects(kit.models('m1', 'openai.ffffff'), /unknown account: openai\.ffffff/);
    await assert.rejects(kit.room('m1', 'openai.ffffff'), /unknown account: openai\.ffffff/);

    // Keys are host-only: addAccount refuses key material.
    await assert.rejects(kit.addAccount('m1', { authChoice: 'openai', key: 'sk-test' } as never, () => {}), /host-only/);

    // Hold the canary by two accounts: every profile read reports it, and both rows keep it across listings.
    maskWho = true;
    const indexFile = indexOf(stateDir, 'm1');
    const stored = JSON.parse(readFileSync(indexFile, 'utf8')) as { accounts: Record<string, { who?: string }> };
    stored.accounts.openai!.who = canaryWho;
    stored.accounts[second.id]!.who = canaryWho;
    writeFileSync(indexFile, JSON.stringify(stored, null, 2) + '\n');
    await kit.accounts('m1');
    assert.equal(readFileSync(indexFile, 'utf8').split(canaryWho).length - 1, 2);

    // A stub device link through the built kit.
    const api = openclawLink(kit, { memberOf: (grant) => (grant.meta as { member?: string } | undefined)?.member });
    const grant = { id: 'o14m-g1', key: 'k', name: 'phone', role: 'control', created: Date.now(), meta: { member: 'm1' } } as Grant;

    // oc.sessions shows the member key and the account agent's, never another member's or an unindexed agent's.
    fake.handle('sessions.list', () => ({ sessions: [{ sessionKey: 'agent:m1:x' },
      { sessionKey: `agent:${agent}:y` }, { sessionKey: 'agent:m1--ffffff:ghost' }, { sessionKey: 'agent:b:z' }] }));
    const sessions = await api.handle({ op: 'oc.sessions' }, grant) as { sessionKey: string }[];
    snap(sessions);
    assert.deepEqual(sessions.map((s) => s.sessionKey).sort(), ['agent:m1:x', `agent:${agent}:y`].sort());

    // oc.events carries the account agent's gateway events and approval frames under the member.
    const lines: string[] = [];
    const server: { write(d: string): Promise<void>; end(e?: string): void; onEnd?: () => void } = {
      write: async (d) => { lines.push(d); snap(JSON.parse(d)); },
      end: () => {},
    };
    await api.stream!(server as unknown as LinkStream, { op: 'oc.events' }, grant);
    fake.emit('agent', { agentId: agent, runId: 'r-o14m', stream: 'assistant', data: { text: 'mine' } });
    fake.emit('agent', { agentId: 'b', runId: 'r-foreign', stream: 'assistant', data: { text: 'nope' } });
    fake.emit('agent', { agentId: 'm1--ffffff', runId: 'r-ghost', stream: 'assistant', data: { text: 'ghost' } });
    await kit.call('exec.approval.request', { id: 'o14m-a2', command: 'oil antenna', agentId: 'm1', sessionKey: 'agent:m1:x' });
    await kit.call('exec.approval.request', { id: 'o14m-a3', command: 'ghost', agentId: 'm1--ffffff', sessionKey: 'agent:m1--ffffff:ghost' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]!) as { event: string }).event, 'agent');
    assert.equal((JSON.parse(lines[1]!) as { event: string }).event, 'approval');
    assert.ok(!kit.approvals('m1').some((a) => a.id === 'o14m-a3'));
    server.onEnd?.();

    // An unindexed account-shaped agent is unreachable through steer and abort as well.
    await assert.rejects(Promise.resolve().then(() => api.handle({ op: 'oc.steer', args: { sessionKey: 'agent:m1--ffffff:ghost', text: 'hi' } }, grant)),
      new RegExp(words('link.notAllowed').slice(0, 20)));
    await assert.rejects(Promise.resolve().then(() => api.handle({ op: 'oc.abort', args: { sessionKey: 'agent:m1--ffffff:ghost' } }, grant)),
      new RegExp(words('link.notAllowed').slice(0, 20)));

    // oc.run carries the account selection: the account frame comes first.
    fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 80 }]);
    fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 10 }]);
    for (const id of ['openai', second.id]) await kit.room('m1', id);
    const runLines: string[] = [];
    const runServer: { write(d: string): Promise<void>; end(e?: string): void; onEnd?: () => void } = {
      write: async (d) => { runLines.push(d); snap(JSON.parse(d)); },
      end: () => {},
    };
    await api.stream!(runServer as unknown as LinkStream,
      { op: 'oc.run', args: { message: 'hello', sessionKey: 'agent:m1:link:1', account: second.id } }, grant);
    const hostFrames = runLines.map((l) => JSON.parse(l) as { type: string; account?: string });
    assert.equal(hostFrames[0]?.type, 'account');
    assert.equal(hostFrames[0]?.account, second.id);
    assert.equal(hostFrames.at(-1)?.type, 'end');

    // The device client sends the account selection and refuses a misshapen key before any request.
    const enc = new TextEncoder();
    const pending: Uint8Array[] = [];
    let toDevice: ((c: Uint8Array) => void) | undefined;
    let deviceDone: ((e?: string) => void) | undefined;
    let ended = false;
    let endedWith: string | undefined;
    const stubLink = {
      request: (op: string, args?: unknown) => api.handle({ op, args }, grant),
      stream: async (op: string, args?: unknown) => {
        const serverSide = {
          write: async (d: string) => {
            const bytes = enc.encode(d);
            if (toDevice) toDevice(bytes);
            else pending.push(bytes);
          },
          end: (e?: string) => { ended = true; endedWith = e; deviceDone?.(e); },
        } as unknown as LinkStream;
        void api.stream!(serverSide, { op, args }, grant);
        return {
          set onData(fn: (c: Uint8Array) => void) { toDevice = fn; for (const bytes of pending.splice(0)) fn(bytes); },
          set onEnd(fn: (e?: string) => void) { deviceDone = fn; if (ended) fn(endedWith); },
          write: async (_d: string) => {},
          end: (_e?: string) => {},
        } as unknown as LinkStream;
      },
    } as unknown as DeviceLink;
    const oc = openclawDevice(stubLink);
    const deviceFrames: unknown[] = [];
    for await (const frame of oc.run('hello', { sessionKey: 'agent:m1:link:2', account: 'auto' })) {
      deviceFrames.push(frame);
      snap(frame);
    }
    assert.equal((deviceFrames[0] as { type: string }).type, 'account');
    assert.equal((deviceFrames[0] as { account: string }).account, second.id);
    snap(await oc.sessions());
    await assert.rejects(async () => { for await (const frame of oc.run('hi', { sessionKey: 'not-a-key' })) snap(frame); }, /Invalid session key/);

    // The canary held by two accounts never appears in a link frame, including the state, approval and sign-in views.
    snap(await api.handle({ op: 'oc.state' }, grant));
    snap(await api.handle({ op: 'oc.approvals' }, grant));
    snap(await api.handle({ op: 'oc.signin.view', args: { provider: 'openai' } }, grant));
    const text = frames.join('\n');
    for (const canary of [canaryWho, 'canary-o14m-shared', 'canary-o14m-other'])
      assert.ok(!text.includes(canary), `link frame leaks ${canary}`);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// A removal that dies right after agents.delete (off the roster, entry and state dir still on disk) finishes on retry.
test('a removal that dies after agents.delete finishes on retry', async () => {
  const stateDir = scratchDir('o14h-retry');
  const fake = fakeGateway();
  const root = join(stateDir, 'openclaw');
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    await kit.stop();
    const agentDir = join(root, 'state', 'agents', agent);
    mkdirSync(join(agentDir, 'agent'), { recursive: true });
    writeFileSync(join(agentDir, 'agent', 'auth.json'), '{}');

    let crashed = false;
    const dying: typeof fake.factory = (ctx) => {
      const transport = fake.factory(ctx);
      return { ...transport, request: async (method, params, o) => {
        const answer = await transport.request(method, params, o);
        if (method === 'agents.delete' && !crashed) { crashed = true; throw new Error('process died after agents.delete'); }
        return answer;
      } };
    };
    const kit2 = new OpenClawKit({ stateDir, transport: dying, spawnEngine: false, callbackPort: 0 });
    try {
      await kit2.start();
      await assert.rejects(kit2.removeAccount('m1', second.id), /process died after agents.delete/);
    } finally { await kit2.stop(); }
    assert.ok(second.id in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts, 'the entry remains');
    assert.ok(existsSync(agentDir), 'the state dir remains');

    const kit3 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
    try {
      await kit3.start();
      await kit3.removeAccount('m1', second.id);
      assert.ok(!(second.id in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts), 'the retry drops the entry');
      assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'and removes the state dir');
    } finally { await kit3.stop(); }
  } finally {
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

test('prepare keeps a legacy member dir even when its owner has an index, and removes only a recorded account dir', async () => {
  const stateDir = scratchDir('o14h-legacy-sweep');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    await kit.accounts('m1');
    assert.ok(existsSync(indexOf(stateDir, 'm1')), 'm1 has an index');
    await kit.stop();
    const agents = join(stateDir, 'openclaw', 'state', 'agents');
    const legacy = join(agents, 'ops--a1b2c3', 'agent', 'auth.json');
    const removed = join(agents, 'm1--abcdef', 'agent', 'auth.json');
    for (const file of [legacy, removed]) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '{}'); }
    mkdirSync(join(stateDir, 'openclaw', 'accounts'), { recursive: true });
    writeFileSync(indexOf(stateDir, 'ops'), JSON.stringify({ v: 1, accounts: {}, defaults: {} }, null, 2) + '\n');
    const file = indexOf(stateDir, 'm1');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), gone: ['m1--abcdef'] }, null, 2) + '\n');
    const kit2 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
    try {
      await kit2.prepare();
      assert.ok(existsSync(legacy), 'the legacy member keeps its sign-in');
      assert.ok(!existsSync(join(agents, 'm1--abcdef')), 'a removed account dir is swept');
    } finally { await kit2.stop(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('a late write to a removed account dir is swept after a sealed restore, before launch', async () => {
  const stateDir = scratchDir('o14h-sealed-sweep');
  const fake = fakeGateway();
  const authSeal = hostKeySeal({ key: new Uint8Array(32).fill(9) });
  const agents = join(stateDir, 'openclaw', 'state', 'agents');
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    await kit.removeAccount('m1', second.id);
    const late = join(agents, agent, 'agent', 'auth.json');
    mkdirSync(join(late, '..'), { recursive: true });
    writeFileSync(late, '{}');
    await kit.stop();
    const kit2 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
    try {
      await kit2.start();
      assert.ok(!existsSync(join(agents, agent)), 'the removed agent leaves no file after the sealed restore');
    } finally { await kit2.stop(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('removing an account while the engine runs survives a SQLite journal that vanishes during the reseal', async () => {
  const stateDir = scratchDir('o14h-journal-vanish');
  const fake = fakeGateway();
  const base = hostKeySeal({ key: new Uint8Array(32).fill(7) });
  let vanish: string | undefined;
  const authSeal = {
    encryptString: (text: string) => {
      if (vanish) { rmSync(vanish, { force: true }); vanish = undefined; }
      return base.encryptString(text);
    },
    decryptString: (data: Buffer) => base.decryptString(data),
  };
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const live = join(stateDir, 'openclaw', 'state', 'agents', 'm1', 'agent');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'openclaw-agent.sqlite'), 'live-db');
    writeFileSync(join(live, 'openclaw-agent.sqlite-journal'), 'live-journal');
    vanish = join(live, 'openclaw-agent.sqlite-journal');
    await kit.removeAccount('m1', second.id);
    assert.equal(vanish, undefined, 'the reseal ran and the journal was deleted before it was read');
    assert.ok(!(second.id in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts), 'the removal committed');
    assert.equal(readFileSync(join(live, 'openclaw-agent.sqlite'), 'utf8'), 'live-db');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a member sign-in that lands again during logout is refused, keeps its entry, and a retry clears it', async () => {
  const stateDir = scratchDir('o14h-member-relogin');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    assert.ok((await kit.accounts('m1')).some((a) => a.id === 'openai'));
    await kit.stop();
    let logouts = 0;
    const relogin: typeof fake.factory = (ctx) => {
      const transport = fake.factory(ctx);
      return { ...transport, request: async (method, params, o) => {
        const answer = await transport.request(method, params, o);
        if (method === 'models.authLogout' && logouts++ === 0) fake.refresh('m1', 'openai');
        return answer;
      } };
    };
    const kit2 = new OpenClawKit({ stateDir, transport: relogin, spawnEngine: false, callbackPort: 0 });
    try {
      await kit2.start();
      await assert.rejects(kit2.removeAccount('m1', 'openai'), /still signing in/, 'a profile that lands again refuses removal');
      assert.ok('openai' in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts, 'and keeps the entry');
      await kit2.removeAccount('m1', 'openai');
      assert.equal(logouts, 2, 'the retry logs the landed profile out too');
      assert.ok(!('openai' in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts), 'and the retry drops the entry');
    } finally { await kit2.stop(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

// Member remove restores the pre-sign-in primary (or clears the pin when there was none); an account-agent remove
// leaves the member primary alone.
test('removeAccount restores or clears the member primary model', async () => {
  const stateDir = scratchDir('o14h-remove-model');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  type Cfg = { hash: string; config: { agents: { entries: Record<string, { model?: unknown }> } } };
  const configOf = async (): Promise<Cfg> => await kit.call('config.get', {}) as Cfg;
  const modelOf = async (agentId: string) => (await configOf()).config.agents.entries[agentId]?.model;
  try {
    await kit.start();
    await kit.ensureMember('m1');
    // Prior model: add then remove restores it; the index carried priorModel.
    await kit.call('config.patch', { raw: JSON.stringify({ agents: { ownership: 'explicit',
      entries: { m1: { model: 'openai/before-sign-in' } } } }),
      baseHash: (await configOf()).hash });
    assert.equal((await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {}).then((h) => h.done)).view.state, 'done');
    assert.match(String(await modelOf('m1')), /@openai:default/, 'sign-in pins the member primary');
    assert.equal(JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts.openai.priorModel, 'openai/before-sign-in');
    await kit.removeAccount('m1', 'openai');
    assert.equal(await modelOf('m1'), 'openai/before-sign-in', 'remove restores the prior primary');
    assert.ok(!('openai' in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts));

    // No prior model: remove clears the pin so the engine default applies.
    // Clear the restored primary so this sign-in records an empty priorModel.
    await kit.call('agents.update', { agentId: 'm1', model: null });
    assert.equal(await modelOf('m1'), undefined);
    assert.equal((await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {}).then((h) => h.done)).view.state, 'done');
    assert.equal(JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts.openai.priorModel, '');
    const clearsBefore = fake.calls.filter((c) => c.method === 'agents.update'
      && (c.params as { model?: unknown }).model === null).length;
    await kit.removeAccount('m1', 'openai');
    assert.ok(fake.calls.filter((c) => c.method === 'agents.update'
      && (c.params as { model?: unknown }).model === null).length > clearsBefore, 'empty prior clears via agents.update');
    assert.equal(await modelOf('m1'), undefined, 'the pin is gone');

    // Account-agent remove leaves the member primary unchanged.
    await kit.call('config.patch', { raw: JSON.stringify({ agents: { entries: { m1: { model: 'openai/member-stays' } } } }),
      baseHash: (await configOf()).hash });
    assert.equal((await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {}).then((h) => h.done)).view.state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const before = await modelOf('m1');
    await kit.removeAccount('m1', second.id);
    assert.equal(await modelOf('m1'), before, 'removing an account agent does not touch the member primary');
    assert.ok('openai' in JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')).accounts, 'the member account stays');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// A late token refresh after member-agent authLogout can rewrite state/agents/<member>; prepare must drop that
// profile so listing cannot synthesize the removed account, while every other account stays.
test('prepare sweeps a late member-store refresh of a removed account', async () => {
  const stateDir = scratchDir('o14h-member-late-refresh');
  const fake = fakeGateway();
  const root = join(stateDir, 'openclaw');
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const go = await kit.addAccount('m1', { authChoice: 'opencode-go' }, () => {});
    go.paste('CANARY-GO-MEMBER-LATE-REFRESH');
    assert.equal((await go.done).view.state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const keptAgent = second.id;
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id).sort(), ['openai', 'opencode-go', keptAgent].sort());
    await kit.removeAccount('m1', 'openai');
    const indexAfter = JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')) as {
      accounts: Record<string, unknown>; dropped?: string[];
    };
    assert.ok(!('openai' in indexAfter.accounts));
    assert.deepEqual(indexAfter.dropped, ['openai'], 'removal tombstones the member provider');
    assert.ok('opencode-go' in indexAfter.accounts, 'the other member account stays');
    assert.ok(keptAgent in indexAfter.accounts, 'and the account agent stays');
    const memberStore = join(root, 'state', 'agents', 'm1', 'agent', 'auth-profiles.json');
    mkdirSync(join(memberStore, '..'), { recursive: true });
    writeFileSync(memberStore, JSON.stringify({
      version: 1,
      profiles: {
        'openai:default': { type: 'oauth', provider: 'openai', access: 'late-access', refresh: 'late-refresh' },
        'opencode-go:default': { type: 'api_key', provider: 'opencode-go', key: 'kept-on-member' },
      },
      order: { openai: ['openai:default'], 'opencode-go': ['opencode-go:default'] },
    }));
    await kit.prepare();
    const swept = JSON.parse(readFileSync(memberStore, 'utf8')) as {
      profiles: Record<string, { provider?: string }>;
      order?: Record<string, unknown>;
    };
    assert.equal(swept.profiles['openai:default'], undefined, 'the late member refresh is gone');
    assert.equal(swept.profiles['opencode-go:default']?.provider, 'opencode-go', 'the remaining member profile stays');
    assert.deepEqual(swept.order, { 'opencode-go': ['opencode-go:default'] });
    const index = JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')) as { accounts: Record<string, unknown> };
    assert.ok(!('openai' in index.accounts), 'the removed member account stays out of the index');
    assert.ok('opencode-go' in index.accounts, 'the remaining member account entry is intact');
    assert.ok(keptAgent in index.accounts, 'and the account agent entry is intact');
    const listed = (await kit.accounts('m1')).map((a) => a.id).sort();
    assert.deepEqual(listed, ['opencode-go', keptAgent].sort());

  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('removeAccount is refused busy while a run holds the account agent or the member agent live, and keeps the entry', async () => {
  const stateDir = scratchDir('o14h-remove-live');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 80 }]);
    fake.setUsage(agent, 'openai', [{ label: 'session', usedPercent: 10 }]);
    for (const id of ['openai', second.id]) await kit.room('m1', id);
    const refusedWhileLive = async (account: string, liveAgent: string) => {
      let started!: () => void;
      const running = new Promise<void>((resolve) => { started = resolve; });
      const pending = kit.run({ member: 'm1', sessionKey: `agent:m1:live-${account}`, message: 'hello', account },
        (e) => { if (e.type === 'started') started(); });
      await running;
      await assert.rejects(kit.removeAccount('m1', account), /removeAccount: busy/);
      assert.ok((await kit.accounts('m1')).some((a) => a.id === account), 'the entry stays');
      assert.ok((await kit.call('agents.list', {})).agents.some((a) => a.id === liveAgent), 'and the agent');
      assert.ok((await pending).ok, 'the live run finishes');
    };
    await refusedWhileLive(second.id, agent);
    await refusedWhileLive('openai', 'm1');
    assert.equal((await kit.accounts('m1')).find((a) => a.id === 'openai')?.state, 'ready', 'the member stays ready');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a reseal during a run leaves the sealed databases as they were and drops only the removed agent\'s', async () => {
  const stateDir = scratchDir('o14h-reseal-db');
  const fake = fakeGateway();
  const authSeal = hostKeySeal({ key: new Uint8Array(32).fill(5) });
  const root = join(stateDir, 'openclaw');
  const objects = join(root, 'auth-store.objects');
  const sealedObjects = () => new Map(readdirSync(objects).map((name) => [name, readFileSync(join(objects, name))] as const));
  const databaseText = (bytes: Buffer) => Buffer.from((JSON.parse(authSeal.decryptString(bytes)) as { data: string }).data, 'base64').toString();
  const plant = (agent: string, text: string) => {
    const dir = join(root, 'state', 'agents', agent, 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openclaw-agent.sqlite'), text);
  };
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    plant('m1', 'member-db-v1');
    plant(agent, 'removed-db');
    await kit.stop();
    const before = sealedObjects();
    assert.ok([...before.values()].some((bytes) => databaseText(bytes) === 'removed-db'), 'both databases are sealed at stop');

    const running = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
    try {
      await running.start();
      writeFileSync(join(root, 'state', 'agents', 'm1', 'agent', 'openclaw-agent.sqlite'), 'member-db-v2');
      await running.removeAccount('m1', second.id);
      const after = sealedObjects();
      assert.equal([...before.keys()].filter((name) => !after.has(name)).length, 1, 'only the removed agent database is dropped');
      for (const [name, bytes] of after) assert.deepEqual(bytes, before.get(name), 'the other sealed databases are not rewritten');
      assert.deepEqual([...after.values()].map(databaseText).sort(), ['member-db-v1'], 'no removed-agent or live database is sealed mid-run');
    } finally { await running.stop(); }
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a v:2 snapshot that drops a removed account re-seals as v:1 on restore', async () => {
  const stateDir = scratchDir('o14h-v2-tombstone');
  const fake = fakeGateway();
  const authSeal = hostKeySeal({ key: new Uint8Array(32).fill(6) });
  const root = join(stateDir, 'openclaw');
  const blob = join(root, 'auth-store.sealed');
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    mkdirSync(join(root, 'state', 'agents', agent, 'agent'), { recursive: true });
    writeFileSync(join(root, 'state', 'agents', agent, 'agent', 'auth-profiles.json'), '{}');
    await kit.stop();
    const index = JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8'));
    delete index.accounts[second.id];
    index.gone = [agent];
    writeFileSync(indexOf(stateDir, 'm1'), JSON.stringify(index));
    const snap = JSON.parse(authSeal.decryptString(readFileSync(blob))) as { v: number; dirs: string[]; files: [string, string][] };
    assert.ok(snap.files.some(([path]) => path.includes(agent)), 'the sealed snapshot still holds the account agent profile');
    writeFileSync(blob, authSeal.encryptString(JSON.stringify({ ...snap, v: 2 })));
    const kit2 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
    try {
      await kit2.start();
      assert.equal((JSON.parse(authSeal.decryptString(readFileSync(blob))) as { v: number }).v, 1, 're-sealed as v: 1');
      assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'and the removed agent dir is gone');
    } finally { await kit2.stop(); }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a failed member-agent seal says the credential is still there when its clear is refused', async () => {
  const stateDir = scratchDir('o14h-seal-clear-refused');
  const fake = fakeGateway();
  let seals = 0;
  const refusing: typeof fake.factory = (ctx) => {
    const transport = fake.factory(ctx);
    return { ...transport, request: async (method, params, o) => {
      const { action, provider } = (params ?? {}) as { action?: string; provider?: string };
      if (method === 'byokit.accounts' && action === 'seal' && seals++ === 0) return { ok: false };
      if (method === 'byokit.accounts' && action === 'clear' && provider === 'openai') return { ok: false };
      return transport.request(method, params, o);
    } };
  };
  const kit = new OpenClawKit({ stateDir, transport: refusing, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    await kit.ensureMember('m2');
    const failed = await kit.addAccount('m2', { authChoice: 'openai', via: 'browser' }, () => {});
    const { view } = await failed.done;
    assert.equal(view.state, 'failed');
    assert.match(view.error ?? '', /still on the member agent/);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('removeAccount is refused busy while an account sign-in is pending, and the entry stays', async () => {
  const stateDir = scratchDir('o14h-remove-pending');
  const fake = fakeGateway();
  let holding = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holdingTransport: typeof fake.factory = (ctx) => {
    const transport = fake.factory(ctx);
    return { ...transport, request: async (method, params, o) => {
      if (method === 'openclaw.setup.auth.start' && holding) await gate;
      return transport.request(method, params, o);
    } };
  };
  const kit = new OpenClawKit({ stateDir, transport: holdingTransport, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.deepEqual(await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done, { state: 'done', via: 'browser' });
    holding = true;
    const pending = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    await assert.rejects(kit.removeAccount('m1', pending.id), /busy/);
    assert.ok((await kit.accounts('m1')).some((a) => a.id === pending.id), 'the entry stays');
    holding = false;
    release();
    assert.equal((await pending.done).view.state, 'done');
    assert.ok((await kit.accounts('m1')).some((a) => a.id === pending.id), 'the signed-in entry stays');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// A damaged index quarantines only that member: its agents are held back (never restored, never swept, never
// resealed away), the other members restore, start and persist normally, and the kit reports words
// `account.indexDamaged`. Rewriting a good index restores the held-back agents.
test('a damaged index quarantines only that member, and a repaired index restores it', async () => {
  const stateDir = scratchDir('o14x-index-recovery');
  const fake = fakeGateway();
  const authSeal = hostKeySeal({ key: new Uint8Array(32).fill(11) });
  const lines: string[] = [];
  const log = (line: string): void => { lines.push(line); };
  const root = join(stateDir, 'openclaw');
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal, log });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const second = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await second.done).view.state, 'done');
    const agent = `m1--${second.id.slice('openai.'.length)}`;
    assert.equal((await kit.signIn('m2', { authChoice: 'openai' }, () => {}).done).state, 'done');
    assert.equal((await kit.signIn('m3', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const plant = (dir: string, text: string): void => {
      mkdirSync(join(root, 'state', 'agents', dir, 'agent'), { recursive: true });
      writeFileSync(join(root, 'state', 'agents', dir, 'agent', 'auth.json'), text);
    };
    plant(agent, 'held-back-marker');
    plant('m2', 'm2-marker');
    await kit.stop();

    const goodIndex = readFileSync(indexOf(stateDir, 'm1'), 'utf8');
    writeFileSync(indexOf(stateDir, 'm1'), '{');
    const kit2 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal, log });
    try {
      await kit2.start();
      assert.deepEqual((await kit2.accounts('m2')).map((a) => a.id), ['openai']);
      assert.deepEqual((await kit2.accounts('m3')).map((a) => a.id), ['openai']);
      const damaged = words('account.indexDamaged', { member: 'm1' });
      await assert.rejects(kit2.accounts('m1'), (error: Error) => error.message === damaged);
      assert.ok(lines.some((line) => line.includes(damaged)), 'the kit reports the damaged index');
      assert.equal(readFileSync(indexOf(stateDir, 'm1'), 'utf8'), '{', 'the damaged index is kept, not deleted');
      assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'the quarantined agent is held back, not restored');
      assert.equal(readFileSync(join(root, 'state', 'agents', 'm2', 'agent', 'auth.json'), 'utf8'), 'm2-marker');
      await kit2.stop();
      const sealed = JSON.parse(authSeal.decryptString(readFileSync(join(root, 'auth-store.sealed')))) as
        { files: [string, string][] };
      assert.ok(sealed.files.some(([path]) => path.includes(agent)), 'the held-back file stays sealed, not deleted');
    } finally { await kit2.stop(); }

    writeFileSync(indexOf(stateDir, 'm1'), goodIndex);
    const kit3 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal, log });
    try {
      await kit3.start();
      assert.deepEqual((await kit3.accounts('m1')).map((a) => a.id).sort(), ['openai', second.id].sort());
      assert.equal(readFileSync(join(root, 'state', 'agents', agent, 'agent', 'auth.json'), 'utf8'), 'held-back-marker');
    } finally { await kit3.stop(); }
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Fail closed across the quarantine: a removed account's data never returns while another member's index is
// damaged, the good member's sweep still runs, and a re-add rewrites the damaged index.
test('removed-account data never returns with a damaged index, and a re-add rewrites it', async () => {
  const stateDir = scratchDir('o14x-index-removed');
  const fake = fakeGateway();
  const authSeal = hostKeySeal({ key: new Uint8Array(32).fill(12) });
  const root = join(stateDir, 'openclaw');
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
  try {
    await kit.start();
    assert.equal((await kit.signIn('m1', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const live = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await live.done).view.state, 'done');
    const held = `m1--${live.id.slice('openai.'.length)}`;
    assert.equal((await kit.signIn('m2', { authChoice: 'openai' }, () => {}).done).state, 'done');
    const gone = await kit.addAccount('m2', { authChoice: 'openai', via: 'browser' }, () => {});
    assert.equal((await gone.done).view.state, 'done');
    const removed = `m2--${gone.id.slice('openai.'.length)}`;
    await kit.removeAccount('m2', gone.id);
    await kit.stop();

    writeFileSync(indexOf(stateDir, 'm1'), '{not json');
    const late = (dir: string, text: string): void => {
      mkdirSync(join(root, 'state', 'agents', dir, 'agent'), { recursive: true });
      writeFileSync(join(root, 'state', 'agents', dir, 'agent', 'auth.json'), text);
    };
    late(held, 'late-live');
    late(removed, 'late-removed');
    const kit2 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
    try {
      await kit2.start();
      assert.ok(!existsSync(join(root, 'state', 'agents', removed)), 'the good member removed agent is still swept');
      assert.equal(readFileSync(join(root, 'state', 'agents', held, 'agent', 'auth.json'), 'utf8'), 'late-live');
      assert.deepEqual((await kit2.accounts('m2')).map((a) => a.id), ['openai']);
      await assert.rejects(kit2.accounts('m1'), (error: Error) =>
        error.message === words('account.indexDamaged', { member: 'm1' }));
      await kit2.stop();
      const sealed = JSON.parse(authSeal.decryptString(readFileSync(join(root, 'auth-store.sealed')))) as
        { files: [string, string][] };
      assert.ok(!sealed.files.some(([path]) => path.includes(removed)), 'the removed agent leaves no sealed file');
      for (const [, data] of sealed.files)
        assert.notEqual(Buffer.from(data, 'base64').toString(), 'late-live', 'the held-back write is never resealed');
    } finally { await kit2.stop(); }

    const kit3 = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0, authSeal });
    try {
      await kit3.start();
      const readded = await kit3.addAccount('m1', { authChoice: 'openai', via: 'browser' }, () => {});
      assert.equal((await readded.done).view.state, 'done');
      assert.doesNotThrow(() => JSON.parse(readFileSync(indexOf(stateDir, 'm1'), 'utf8')), 'the re-add rewrites a good index');
      assert.ok((await kit3.accounts('m1')).some((a) => a.id === readded.id));
    } finally { await kit3.stop(); }
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
