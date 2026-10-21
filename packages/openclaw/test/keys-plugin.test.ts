// The shipped key handler, run against the engine's agent-dir and auth-store functions stubbed with one JSON file per agent.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { scratchDir } from '../../test-support.ts';

const apiKey = (provider: string) => ({ type: 'api_key', provider, key: 'CANARY-PLUGIN-KEY' });

async function harness() {
  const dir = scratchDir('keys-plugin');
  const state = join(dir, 'state');
  const config = join(dir, 'openclaw.json');
  const previous = process.env.OPENCLAW_CONFIG_PATH;
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  copyFileSync(new URL('../plugin/keys.js', import.meta.url), join(dir, 'keys.js'));
  mkdirSync(join(dir, 'node_modules/openclaw'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/openclaw/package.json'), JSON.stringify({ name: 'openclaw', type: 'module', exports: {
    './plugin-sdk/agent-scope-runtime': './agent-runtime.js', './plugin-sdk/provider-auth': './provider-auth.js' } }));
  writeFileSync(join(dir, 'node_modules/openclaw/agent-runtime.js'), `import { join } from 'node:path';
export function resolveAgentDir(config, id) { return join(${JSON.stringify(state)}, 'agents', id); }
`);
  writeFileSync(join(dir, 'node_modules/openclaw/provider-auth.js'), `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function updateAuthProfileStoreWithLock({ agentDir, updater }) {
  mkdirSync(agentDir, { recursive: true });
  const file = join(agentDir, 'auth-profiles.json');
  const store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { profiles: {} };
  const changed = updater(store);
  if (changed) writeFileSync(file, JSON.stringify(store));
  return changed;
}
`);
  writeFileSync(config, JSON.stringify({ agents: { entries: { m1: {},
    'byokit-key-m1': { model: 'openai/gpt-test@openai:byokit' } } } }));
  process.env.OPENCLAW_CONFIG_PATH = config;
  let handler: ((input: { params: Record<string, unknown>; respond: (ok: boolean, value: unknown) => void }) => Promise<void>) | undefined;
  const { registerKeys } = await import(pathToFileURL(join(dir, 'keys.js')).href);
  registerKeys({ registerGatewayMethod: (_name: string, fn: typeof handler) => { handler = fn; } });
  return {
    seed(agent: string, store: object) {
      mkdirSync(join(state, 'agents', agent), { recursive: true });
      writeFileSync(join(state, 'agents', agent, 'auth-profiles.json'), JSON.stringify(store));
    },
    call: (params: Record<string, unknown>) => new Promise<any>((resolve) => {
      handler!({ params, respond: (_ok, value) => resolve(value) });
    }),
    stop() {
      if (previous === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a refused prepare keeps the sealed key and its ready marker, and a later replacing prepare removes it', async () => {
  const h = await harness();
  try {
    h.seed('byokit-key-m1', { profiles: { 'openai:byokit': apiKey('openai') } });
    assert.equal((await h.call({ member: 'm1', action: 'seal' })).ok, true);
    assert.deepEqual(await h.call({ member: 'm1', action: 'ready' }), { ok: true, model: 'openai/gpt-test' });
    h.seed('m1', { profiles: { 'openai:main': apiKey('openai') } });
    assert.equal((await h.call({ member: 'm1', action: 'prepare', provider: 'openai' })).ok, false);
    assert.deepEqual(await h.call({ member: 'm1', action: 'ready' }), { ok: true, model: 'openai/gpt-test' });
    h.seed('m1', { profiles: {} });
    assert.equal((await h.call({ member: 'm1', action: 'prepare', provider: 'openai' })).ok, true);
    assert.deepEqual(await h.call({ member: 'm1', action: 'ready' }), { ok: false, absent: true });
  } finally { h.stop(); }
});

test('a clear for a member with no key lane is already removed', async () => {
  const h = await harness();
  try {
    // No `m2` entry and no `byokit-key-m2` entry: removal has nothing to drop and says so instead of refusing.
    assert.deepEqual(await h.call({ member: 'm2', action: 'clear' }), { ok: false, absent: true });
    assert.equal((await h.call({ member: 'm2', action: 'ready' })).ok, false);
  } finally { h.stop(); }
});

test('a clear that empties the key store also removes its ready marker', async () => {
  const h = await harness();
  try {
    h.seed('byokit-key-m1', { profiles: { 'openai:byokit': apiKey('openai') } });
    assert.equal((await h.call({ member: 'm1', action: 'seal' })).ok, true);
    assert.deepEqual(await h.call({ member: 'm1', action: 'ready' }), { ok: true, model: 'openai/gpt-test' });
    assert.equal((await h.call({ member: 'm1', action: 'clear' })).ok, true);
    assert.deepEqual(await h.call({ member: 'm1', action: 'ready' }), { ok: false, absent: true });
  } finally { h.stop(); }
});
