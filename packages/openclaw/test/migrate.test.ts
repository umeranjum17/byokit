// Retained-login migration without an engine (5.7, D15): the staging shape an offline doctor reads, a failed run
// that leaves the original byte for byte, and a confirm that moves nothing until the gateway itself says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmRetainedLogin, migrateRetainedLogin } from '../src/migrate.ts';
import type { SignInCtx } from '../src/signin.ts';
import { scratchDir } from '../../test-support.ts';

const legacy = (extra: Record<string, unknown> = {}) => JSON.stringify({
  'openai-codex': { type: 'oauth', provider: 'openai-codex', access: 'a-preserved', refresh: 'r-preserved' },
  ...extra,
}, null, 2);

type House = {
  root: string;
  path: string;
  staging: string;
  prepared: number;
  doctors: number;
  doctor: { status: number | null };
  ctx: { root: string; prepare(): Promise<void>; doctor(): { status: number | null } };
  signInCtx: SignInCtx;
  calls: { method: string; params: unknown }[];
};

function house(providers: unknown[] = []): House {
  const dir = scratchDir('o6-migrate');
  const root = join(dir, 'openclaw');
  const path = join(dir, 'people', 'm1', 'engine', 'auth.json');
  mkdirSync(join(path, '..'), { recursive: true });
  const box = {
    root, path, staging: join(root, 'state', 'agents', 'm1', 'agent', 'auth-profiles.json'),
    prepared: 0, doctors: 0, doctor: { status: 0 as number | null },
    calls: [] as { method: string; params: unknown }[],
  };
  const ctx = { root, prepare: async () => { box.prepared++; }, doctor: () => { box.doctors++; return box.doctor; } };
  const signInCtx: SignInCtx = {
    request: async (method, params) => {
      box.calls.push({ method, params });
      if (method === 'models.authStatus') return { providers };
      if (method === 'agents.list') return { agents: [{ id: 'm1' }] };
      return {};
    },
    ensure: async () => ({ agentId: 'm1' }),
    callbackPort: 0,
  };
  return Object.assign(box, { ctx, signInCtx });
}

const bytes = (path: string) => readFileSync(path, 'utf8');

test('a path source is staged as the profile store the offline doctor imports, 0600', async () => {
  const house1 = house();
  writeFileSync(house1.path, legacy());
  const before = bytes(house1.path);
  assert.equal(await migrateRetainedLogin(house1.ctx, 'm1', { path: house1.path }), 'staged');
  assert.equal(house1.prepared, 1, 'the engine is in place before an import is staged');
  assert.equal(house1.doctors, 1);
  assert.deepEqual(JSON.parse(bytes(house1.staging)), {
    version: 1,
    profiles: { 'openai-codex:default': { type: 'oauth', provider: 'openai-codex', access: 'a-preserved', refresh: 'r-preserved' } },
  });
  assert.equal(statSync(house1.staging).mode & 0o777, 0o600);
  assert.equal(bytes(house1.path), before, 'the original is never written to');
});

test('a failed doctor run deletes the staging it wrote and leaves the source byte for byte, so the next boot retries', async () => {
  const house1 = house();
  writeFileSync(house1.path, legacy());
  const before = bytes(house1.path);
  house1.doctor.status = 78;
  assert.equal(await migrateRetainedLogin(house1.ctx, 'm1', { path: house1.path }), 'failed');
  assert.equal(existsSync(house1.staging), false, 'the half-imported staging is cleared');
  assert.equal(bytes(house1.path), before);
  // The retry stages the same bytes again and succeeds.
  house1.doctor.status = 0;
  assert.equal(await migrateRetainedLogin(house1.ctx, 'm1', { path: house1.path }), 'staged');
  assert.ok(bytes(house1.staging).includes('a-preserved'));
});

test('a failed doctor run never deletes a profile store this call did not write (B4)', async () => {
  const house1 = house();
  writeFileSync(house1.path, legacy());
  mkdirSync(join(house1.staging, '..'), { recursive: true, mode: 0o700 });
  const live = '{"version":1,"profiles":{"openai:default":{"live":true}}}';
  writeFileSync(house1.staging, live);
  house1.doctor.status = 1;
  assert.equal(await migrateRetainedLogin(house1.ctx, 'm1', { path: house1.path }), 'failed');
  assert.equal(bytes(house1.staging), live, 'the member\'s live sign-in survives the failed import');
  assert.equal(bytes(house1.path), legacy());
});

test('an invalid member id is refused before anything is written (B5)', async () => {
  const house1 = house();
  writeFileSync(house1.path, legacy());
  for (const member of ['../escaped', '../../../escaped', 'A', 'm1/../../escaped', '']) {
    await assert.rejects(migrateRetainedLogin(house1.ctx, member, { path: house1.path }), /invalid member/, member);
    await assert.rejects(confirmRetainedLogin(house1.signInCtx, member, { path: house1.path }), /invalid member/, member);
  }
  assert.equal(house1.prepared, 0);
  assert.equal(house1.doctors, 0);
  assert.equal(existsSync(join(house1.root, '..', 'escaped')), false, 'nothing escaped state/agents');
  assert.equal(existsSync(join(house1.root, 'state', 'agents', 'm1', 'agent')), false);
});

test('an already-staged profile store is not overwritten, and the staging directory is private (N7)', async () => {
  const house1 = house();
  writeFileSync(house1.path, legacy({ anthropic: { type: 'token', provider: 'anthropic', token: 'x' } }));
  assert.equal(await migrateRetainedLogin(house1.ctx, 'm1', { path: house1.path }), 'staged');
  assert.equal(statSync(join(house1.staging, '..')).mode & 0o777, 0o700, 'the agent directory is 0700');
  assert.deepEqual(readdirSync(join(house1.staging, '..')), ['auth-profiles.json'], 'no staging temp file is left behind');
  writeFileSync(house1.staging, '{"version":1,"profiles":{"openai:default":{"kept":true}}}');
  assert.equal(await migrateRetainedLogin(house1.ctx, 'm1', { path: house1.path }), 'staged');
  assert.equal(bytes(house1.staging), '{"version":1,"profiles":{"openai:default":{"kept":true}}}');
});

test('nothing to migrate is nothing: no file, an empty record, and a retired copy without openai-codex', async () => {
  const missing = house();
  assert.equal(await migrateRetainedLogin(missing.ctx, 'm1', { path: missing.path }), 'nothing');
  assert.equal(missing.prepared, 0, 'no engine work for a source that is not there');
  assert.equal(missing.doctors, 0);

  const empty = house();
  writeFileSync(empty.path, '{}');
  assert.equal(await migrateRetainedLogin(empty.ctx, 'm1', { path: empty.path }), 'nothing');
  assert.equal(existsSync(empty.staging), false);
  assert.equal(await migrateRetainedLogin(empty.ctx, 'm1', { record: {} }), 'nothing');

  const retired = house();
  writeFileSync(`${retired.path}.moved-to-engine`, JSON.stringify({ anthropic: { type: 'token', provider: 'anthropic', token: 'x' } }));
  assert.equal(await migrateRetainedLogin(retired.ctx, 'm1', { path: retired.path }), 'nothing');
  assert.equal(existsSync(retired.staging), false);
});

test('a retired copy that still holds openai-codex is repaired', async () => {
  const house1 = house();
  writeFileSync(`${house1.path}.moved-to-engine`, legacy());
  assert.equal(await migrateRetainedLogin(house1.ctx, 'm1', { path: house1.path }), 'staged');
  assert.ok(bytes(house1.staging).includes('openai-codex:default'));
});

test('confirm removes the original only when every provider is signed in, and writes the marker', async () => {
  const house1 = house([{ provider: 'openai' }]);
  writeFileSync(house1.path, legacy());
  assert.equal(await confirmRetainedLogin(house1.signInCtx, 'm1', { path: house1.path }), true);
  assert.equal(existsSync(house1.path), false);
  assert.equal(existsSync(`${house1.path}.moved-to-engine`), false, 'no plaintext archive is left');
  assert.equal(existsSync(`${house1.path}.moved-to-engine.canonicalized`), true);
  const status = house1.calls.filter((call) => call.method === 'models.authStatus');
  assert.deepEqual(status.map((call) => call.params), [{ agentId: 'm1', refresh: true }], 'one verdict is enough');
});

test('confirm leaves everything where it was when a provider is missing, an entry is unrecognizable, or the source is empty', async () => {
  const missing = house([{ provider: 'openai' }]);
  writeFileSync(missing.path, legacy({ anthropic: { type: 'token', provider: 'anthropic', token: 'x' } }));
  assert.equal(await confirmRetainedLogin(missing.signInCtx, 'm1', { path: missing.path }), false, 'anthropic is not signed in');
  assert.ok(existsSync(missing.path));
  assert.equal(existsSync(`${missing.path}.moved-to-engine`), false);
  assert.equal(missing.calls.filter((call) => call.method === 'models.authStatus').length, 3, 'three verdicts, 1.5 s apart, then no');

  const empty = house([{ provider: 'openai' }]);
  assert.equal(await confirmRetainedLogin(empty.signInCtx, 'm1', { path: empty.path }), false, 'no source, nothing moves');
  assert.equal(empty.calls.length, 0, 'an empty source is never even asked about');
  assert.equal(await confirmRetainedLogin(empty.signInCtx, 'm1', { record: {} }), false);
});

test('a record source is confirmed without touching a single file', async () => {
  const house1 = house([{ provider: 'openai' }]);
  mkdirSync(join(house1.path, '..'), { recursive: true });
  writeFileSync(house1.path, legacy());
  const record = { 'openai-codex': { type: 'oauth', provider: 'openai-codex', access: 'a-preserved' } } as Record<string, unknown>;
  assert.equal(await confirmRetainedLogin(house1.signInCtx, 'm1', { record }), true);
  assert.equal(bytes(house1.path), legacy(), 'the app deletes its own copy');
  assert.equal(existsSync(`${house1.path}.moved-to-engine`), false);
});

test('a retired copy that is already aside is verified, removed and marked', async () => {
  const house1 = house([{ provider: 'openai' }]);
  writeFileSync(`${house1.path}.moved-to-engine`, legacy());
  assert.equal(await confirmRetainedLogin(house1.signInCtx, 'm1', { path: house1.path }), true);
  assert.equal(existsSync(`${house1.path}.moved-to-engine`), false);
  assert.ok(existsSync(`${house1.path}.moved-to-engine.canonicalized`));
});

test('an engine that never answers confirms nothing', async () => {
  const house1 = house();
  writeFileSync(house1.path, legacy());
  house1.signInCtx = { ...house1.signInCtx, request: async () => { throw new Error('gateway is down'); } };
  assert.equal(await confirmRetainedLogin(house1.signInCtx, 'm1', { path: house1.path }), false);
  assert.ok(existsSync(house1.path));
});
