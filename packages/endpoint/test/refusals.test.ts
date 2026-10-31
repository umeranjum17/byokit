import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { startEndpoint, EndpointError, type EndpointOptions, type EndpointErrorCode } from '../src/index.ts';

const base = (stateDir: string): EndpointOptions => ({ stateDir, credential: { provider: 'openai', key: 'sk-fixture' }, models: ['gpt-fixture'], binaryPath: '/bin/true' });
const refuses = async (o: EndpointOptions, code: EndpointErrorCode, mentions: RegExp) => {
  await assert.rejects(startEndpoint(o), (e: unknown) => e instanceof EndpointError && e.name === 'EndpointError' && e.code === code && mentions.test(e.message) && !e.message.includes('sk-fixture'));
};

test('every refusal is typed, names what is missing and writes nothing', async () => {
  const dir = scratchDir('endpoint-refuse');
  const state = join(dir, 'state'); mkdirSync(state, { mode: 0o700 });
  await refuses(base('relative/state'), 'bad-state-dir', /absolute/);
  const open = join(dir, 'open'); mkdirSync(open); chmodSync(open, 0o750);
  await refuses(base(open), 'state-dir-open', /chmod 700/);
  const repo = join(dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  await refuses(base(join(repo, 'state')), 'state-dir-in-git', /git work tree/);
  await refuses({ ...base(state), credential: [{ provider: 'openai', key: 'a' }, { provider: 'zai', key: 'b' }] as never }, 'more-than-one-credential', /exactly one/);
  await refuses({ ...base(state), credential: { provider: 'openai', key: ' ' } }, 'bad-credential', /non-empty key/);
  for (const provider of ['claude', 'chatgpt', 'codex', 'openai-codex']) await refuses({ ...base(state), credential: { provider, key: 'x' } as never }, 'subscription-provider', /subscription sign-in/);
  await refuses({ ...base(state), credential: { provider: 'nope', key: 'x' } as never }, 'unknown-provider', /not a key route/);
  await refuses({ ...base(state), models: [] }, 'no-models', /at least one model/);
  for (const host of ['0.0.0.0', '', '::', '192.168.1.5', 'example.com']) await refuses({ ...base(state), host }, 'host-not-loopback', /not loopback/);
  for (const baseUrl of ['http://api.example.com/v1', 'ftp://127.0.0.1/v1', 'not a url']) await refuses({ ...base(state), baseUrl }, 'base-url-refused', /https, or http on 127.0.0.1/);
  for (const name of ['PGSTORE_DSN', 'gitstore_url', 'OBJECTSTORE_BUCKET', 'HOME_JWT']) await refuses({ ...base(state), env: { [name]: 'x' } }, 'store-variable', new RegExp(name, 'i'));
  await refuses({ ...base(state), binaryPath: join(dir, 'missing') }, 'binary-missing', /binaryPath/);
  assert.deepEqual(readdirSync(state), [], 'a refusal creates no endpoint folder');
  assert.equal(existsSync(join(dir, 'relative')), false);
});
