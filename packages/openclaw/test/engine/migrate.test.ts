// The retained-login migration through the real entry points on the real pinned engine (5.7, D15), ported from
// Crewhouse's openclaw-migrate.test.ts: a preserved sign-in survives the upgrade, and an import that never lands
// stays recoverable — the original bytes never move until the gateway itself reports the provider signed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../../src/engine.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { migrateRetainedLogin, confirmRetainedLogin } from '../../src/migrate.ts';
import { providers, type SignInCtx } from '../../src/signin.ts';
import { scratchDir } from '../../../test-support.ts';
import type { GatewayTransport } from '../../src/types.ts';

// Each case gets its own install and state: a preserved sign-in must never depend on another case's engine.

/** A synthetic preserved sign-in, never a person's. `a-preserved` is what a real import must carry across. */
const legacyAuth = (extra: Record<string, unknown> = {}) => JSON.stringify({
  'openai-codex': { type: 'oauth', provider: 'openai-codex', access: 'a-preserved', refresh: 'r-preserved', expires: Date.now() + 30 * 86_400_000 },
  ...extra,
}, null, 2);

type House = { dir: string; stateDir: string; legacy: string; engine: Engine; transport?: GatewayTransport };

async function house(): Promise<House> {
  const dir = scratchDir('o6-migrate-real');
  const stateDir = join(dir, 'state');
  const engineDir = join(dir, 'engine');
  const legacy = join(dir, 'people', 'm1', 'engine', 'auth.json');
  mkdirSync(join(legacy, '..'), { recursive: true });
  const engine = new Engine({ stateDir, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  return { dir, stateDir, legacy, engine };
}

/** The kit's own ctx over this house's real gateway, once it is up. */
/** The gateway needs a moment to bind after spawn: connect only once the port answers. */
const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

async function start(house: House): Promise<SignInCtx> {
  const ctx = await house.engine.start();
  for (let waited = 0; waited < 120_000; waited += 200) {
    if (await listening(ctx.port)) break;
    await delay(200);
    if (waited >= 119_800) throw new Error('the gateway never listened');
  }
  house.transport = gatewayTransport({ ...ctx, bridgeSock: house.engine.bridgeSock });
  await house.transport.start();
  const transport = house.transport;
  const request: GatewayTransport['request'] = (method, params, options) => transport.request(method, params, options);
  return { request, ensure: async (member) => {
    const list = await request('agents.list') as { agents: { id: string }[] };
    if (!list.agents.some((agent) => agent.id === member))
      await request('agents.create', { name: member, workspace: join(house.stateDir, 'openclaw', 'workspaces', member) });
    return { agentId: member };
  }, callbackPort: 0 };
}

const stop = async (house: House) => { await house.transport?.stop(); await house.engine.stop(); };

test('a preserved sign-in survives: staged, imported by the doctor, confirmed by the gateway, then retired as a rename', { timeout: 600_000 }, async () => {
  const home = await house();
  const bytes = legacyAuth();
  writeFileSync(home.legacy, bytes);
  try {
    const migrated = await migrateRetainedLogin(
      { root: home.engine.root, prepare: () => home.engine.prepare(), doctor: () => home.engine.doctor(120_000) },
      'm1', { path: home.legacy });
    assert.equal(migrated, 'staged', 'the import ran once the engine was in place');
    assert.equal(readFileSync(home.legacy, 'utf8'), bytes, 'the original is not retired before the gateway confirms');

    const ctx = await start(home);
    // The offline doctor canonicalized and imported the staged profile: the credential itself crossed over, and the
    // gateway reports the canonical provider before anyone confirms anything.
    const db = new DatabaseSync(join(home.stateDir, 'openclaw', 'state', 'agents', 'm1', 'agent', 'openclaw-agent.sqlite'));
    const profiles = JSON.parse((db.prepare('SELECT store_json FROM auth_profile_store').get() as { store_json: string }).store_json).profiles;
    db.close();
    assert.deepEqual(Object.keys(profiles), ['openai:default']);
    assert.equal(profiles['openai:default'].provider, 'openai');
    assert.equal(profiles['openai:default'].access, 'a-preserved');
    assert.equal(await confirmRetainedLogin(ctx, 'm1', { path: home.legacy }), true, 'the gateway reports the preserved sign-in');
    assert.equal(existsSync(home.legacy), false, 'only a confirmed import retires the copy');
    assert.equal(readFileSync(`${home.legacy}.moved-to-engine`, 'utf8'), bytes, 'the retire is a rename, not a rewrite');
    assert.equal(existsSync(`${home.legacy}.moved-to-engine.canonicalized`), true);
    assert.ok((await providers(ctx, 'm1')).includes('openai'), 'the canonical provider is signed in — no second login asked');
    // The confirmed migration is not repeated on the next boot.
    assert.equal(await migrateRetainedLogin(
      { root: home.engine.root, prepare: () => home.engine.prepare(), doctor: () => home.engine.doctor(120_000) },
      'm1', { path: home.legacy }), 'nothing');
  } finally { await stop(home); }
});

test('an import that never lands is not confirmed: the original stays where it was, and nothing is retired', { timeout: 600_000 }, async () => {
  const home = await house();
  const bytes = JSON.stringify({ openai: { type: 'nonsense', provider: 'openai' } });
  writeFileSync(home.legacy, bytes);
  try {
    assert.equal(await migrateRetainedLogin(
      { root: home.engine.root, prepare: () => home.engine.prepare(), doctor: () => home.engine.doctor(120_000) },
      'm1', { path: home.legacy }), 'staged');
    const ctx = await start(home);
    assert.equal(await confirmRetainedLogin(ctx, 'm1', { path: home.legacy }), false, 'an import that never lands is not confirmed');
    assert.equal(readFileSync(home.legacy, 'utf8'), bytes, 'the original sign-in is intact when the import fails');
    assert.equal(existsSync(`${home.legacy}.moved-to-engine`), false, 'nothing was retired');
  } finally { await stop(home); }
});

test('a retired copy without openai-codex is not worth importing (D15)', { timeout: 60_000 }, async () => {
  const home = await house();
  writeFileSync(`${home.legacy}.moved-to-engine`, JSON.stringify({ anthropic: { type: 'token', provider: 'anthropic', token: 'x' } }));
  assert.equal(await migrateRetainedLogin(
    { root: home.engine.root, prepare: () => home.engine.prepare(), doctor: () => home.engine.doctor(120_000) },
    'm1', { path: home.legacy }), 'nothing');
  assert.equal(existsSync(join(home.stateDir, 'openclaw', 'state', 'agents', 'm1', 'agent', 'auth-profiles.json')), false);
});
