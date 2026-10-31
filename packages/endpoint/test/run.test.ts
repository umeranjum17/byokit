import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from '../../test-support.ts';
import { readEndpointRoom, startEndpoint } from '../src/index.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-cli-proxy-api.mjs');

test('the child runs private: umask 077, no core dump, a bare environment, a 0600 log, and the config goes at stop', async () => {
  const dir = scratchDir('endpoint-run');
  const bin = join(dir, 'cli-proxy-api');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); chmodSync(bin, 0o700);
  const state = join(dir, 'state');
  process.env['PGSTORE_DSN'] = 'host-secret'; process.env['HOME_JWT'] = 'host-secret';
  const logged: string[] = [];
  const ep = await startEndpoint({ stateDir: state, credential: { provider: 'openai', key: 'sk-fixture' }, models: ['m'], binaryPath: bin, port: 18417, log: (l) => logged.push(l), env: { HTTPS_PROXY: 'http://127.0.0.1:1' } });
  try {
    assert.equal(ep.url, 'http://127.0.0.1:18417');
    assert.match(ep.clientKey, /^byokit-/);
    assert.equal((await fetch(`${ep.url}/v1/models`, { headers: { authorization: 'Bearer sk-fixture' } })).status, 401, 'the provider key is not the client key');
    const folder = join(state, 'endpoint');
    const probe = JSON.parse(readFileSync(join(folder, 'probe.json'), 'utf8'));
    assert.deepEqual(probe.argv, ['--config', join(folder, 'config.yaml'), '--local-model'], 'never --home-jwt');
    assert.equal(probe.umask, 0o077);
    assert.equal(probe.coreLimit, '0');
    assert.deepEqual(Object.keys(probe.env).filter((k) => !['PWD', 'SHLVL', '_'].includes(k)).sort(), ['GOTRACEBACK', 'HOME', 'HTTPS_PROXY'], 'only what sh itself adds besides the three');
    assert.equal(probe.env.GOTRACEBACK, 'none');
    assert.equal(probe.cwd, folder);
    assert.equal(probe.configMode, 0o600);
    assert.equal(statSync(join(folder, 'server.log')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(folder, 'server.log'), 'utf8'), /fake server up/);
    assert.deepEqual(logged, ['endpoint: listening on http://127.0.0.1:18417']);
  } finally { await ep.stop(); delete process.env['PGSTORE_DSN']; delete process.env['HOME_JWT']; }
  assert.equal(existsSync(join(state, 'endpoint', 'config.yaml')), false);
  assert.equal(JSON.stringify(logged).includes('sk-fixture'), false);
});

test('room: a plan-key provider reads through @byokit/usage, the rest say there is no usage API', async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => { seen.push(`${url} ${new Headers(init?.headers).get('authorization')}`); return new Response('{"usage":{}}', { status: 200 }); }) as typeof fetch;
  const reading = await readEndpointRoom({ credential: { provider: 'opencode', key: 'plan-key' }, fetch: fakeFetch });
  assert.ok('windows' in reading && reading.provider === 'opencode');
  assert.deepEqual(seen, ['https://opencode.ai/zen/go/v1/usage Bearer plan-key']);
  assert.deepEqual(await readEndpointRoom({ credential: { provider: 'openai', key: 'k' }, fetch: fakeFetch }), { ok: false, code: 'no-usage-api', provider: 'openai' });
  assert.equal(seen.length, 1, 'no request for a provider without a usage API');
});
