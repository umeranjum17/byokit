import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
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
  const stateLink = join(dir, 'state-link'); symlinkSync(join(repo, 'state'), stateLink);
  await refuses(base(stateLink), 'state-dir-symlink', /link could place the key inside a repository/);
  const target = join(dir, 'target'); mkdirSync(target);
  const ancestorLink = join(dir, 'ancestor-link'); symlinkSync(target, ancestorLink);
  await refuses(base(join(ancestorLink, 'not-created', 'state')), 'state-dir-symlink', /link could place the key inside a repository/);
  const nestedRepo = join(dir, 'nested-repo'); mkdirSync(join(nestedRepo, '.git'), { recursive: true });
  for (const nested of ['endpoint', 'auths', 'home']) {
    const nestedState = join(dir, `nested-${nested}`); mkdirSync(nestedState, { mode: 0o700 });
    const endpointDir = join(nestedState, 'endpoint');
    if (nested === 'endpoint') symlinkSync(nestedRepo, endpointDir);
    else {
      mkdirSync(endpointDir, { mode: 0o700 });
      symlinkSync(nestedRepo, join(endpointDir, nested));
    }
    await refuses(base(nestedState), 'state-dir-symlink', /link could place the key inside a repository/);
    assert.equal(existsSync(join(nestedRepo, 'config.yaml')), false);
  }
  await refuses({ ...base(state), credential: [{ provider: 'openai', key: 'a' }, { provider: 'zai', key: 'b' }] as never }, 'more-than-one-credential', /exactly one/);
  await refuses({ ...base(state), credential: { provider: 'openai', key: ' ' } }, 'bad-credential', /non-empty key/);
  await refuses({ ...base(state), credential: { provider: 'claude', key: 'x' } as never }, 'unknown-provider', /not a key route/);
  await refuses({ ...base(state), credential: { provider: 'nope', key: 'x' } as never }, 'unknown-provider', /not a key route/);
  await refuses({ ...base(state), models: [] }, 'no-models', /at least one model/);
  for (const port of [0, -1, 65536, 1.5, Number.NaN, '8317']) await refuses({ ...base(state), port } as never, 'bad-port', /integer from 1 through 65535/);
  for (const host of ['0.0.0.0', '', '::', '192.168.1.5', 'example.com']) await refuses({ ...base(state), host }, 'host-not-loopback', /not loopback/);
  for (const baseUrl of ['https://attacker.example/v1', 'http://api.example.com/v1', 'ftp://127.0.0.1/v1', 'not a url']) await refuses({ ...base(state), baseUrl }, 'base-url-not-provider-host', /api\.openai\.com or loopback HTTP/);
  for (const name of ['PGSTORE_DSN', 'gitstore_url', 'OBJECTSTORE_BUCKET', 'HOME_JWT']) await refuses({ ...base(state), env: { [name]: 'x' } }, 'store-variable', new RegExp(name, 'i'));
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY']) await refuses({ ...base(state), env: { [name]: 'x' } }, 'env-proxy', /caller-supplied proxy would carry the provider key off this device; the endpoint talks to the provider address only/);
  await refuses({ ...base(state), binaryPath: join(dir, 'missing') }, 'binary-missing', /binaryPath/);
  assert.deepEqual(readdirSync(state), [], 'a refusal creates no endpoint folder');
  assert.equal(existsSync(join(dir, 'relative')), false);
});
