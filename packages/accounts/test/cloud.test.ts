import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http2';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { cloudSelection, cloudCredential, CloudAccountError, type CloudOptions } from '../src/cloud.ts';
import { cloudStream } from '../src/cloud-node.ts';
import { CANARY, traceFs } from '../src/testing/index.ts';

const host = { platform: 'node', hostSide: true } as const;
const selections: [string, CloudOptions][] = [
  ['aws-bedrock', { route: 'aws-bedrock:cloud:aws-profile', via: 'cloud', profile: 'selected', home: '/selected', region: 'us-east-1' }],
  ['aws-bedrock', { route: 'aws-bedrock:cloud:credential-chain', via: 'cloud', home: '/selected', region: 'us-east-1' }],
  ['aws-bedrock', { route: 'aws-bedrock:key', via: 'key', key: CANARY, region: 'us-east-1' }],
  ['google-vertex', { route: 'google-vertex:cloud:adc', via: 'cloud', home: '/selected', project: 'fixture', location: 'us-central1' }],
  ['google-vertex', { route: 'google-vertex:cloud:service-account', via: 'cloud', keyFile: '/selected/service.json', project: 'fixture', location: 'us-central1' }],
  ['google-vertex', { route: 'google-vertex:key', via: 'key', key: CANARY }],
  ['azure', { route: 'azure:key', via: 'key', key: CANARY, baseUrl: 'https://fixture.invalid/openai/v1' }],
  ['cloudflare', { route: 'cloudflare:key:cloudflare-workers-ai', via: 'key', key: CANARY, accountId: 'fixture' }],
  ['cloudflare', { route: 'cloudflare:key:cloudflare-ai-gateway', via: 'key', key: CANARY, accountId: 'fixture', gatewayId: 'gateway' }],
  ['aws-bedrock', { route: 'aws-bedrock:endpoint:skip-auth', via: 'endpoint', baseUrl: 'http://127.0.0.1:18000', billing: 'api', region: 'us-east-1' }],
];

test('cloud selections are key-free metadata, explicit and Node-only before option/credential access', () => {
  for (const [provider, options] of selections) {
    const a = cloudSelection(provider, options, host);
    assert.equal(a.billing, 'api');
    assert.ok(!JSON.stringify(cloudCredential(a)).includes(CANARY));
    for (const platform of ['browser', 'rn'] as const) {
      assert.throws(() => cloudSelection(provider, { ...options, get key() { throw new Error('credential touched'); } }, { platform }),
        (e: unknown) => e instanceof CloudAccountError && e.code === 'unsupported_platform');
    }
  }
  assert.throws(() => cloudSelection('aws-bedrock', { route: 'aws-bedrock:cloud:credential-chain', via: 'cloud', region: 'us-east-1' }, host), CloudAccountError);
  assert.throws(() => cloudSelection('azure', { route: 'azure:key', via: 'key', key: CANARY, baseUrl: `https://${CANARY}@fixture.invalid` }, host), CloudAccountError);
  assert.throws(() => cloudSelection('cloudflare', { route: 'cloudflare:key:cloudflare-workers-ai', via: 'key', key: CANARY, accountId: '../another' }, host), CloudAccountError);
  assert.throws(() => cloudSelection('aws-bedrock', { ...selections[9][1], billing: undefined }, host), CloudAccountError);
  assert.throws(() => cloudSelection('azure', selections[2][1], host), CloudAccountError);
});

// AWS event-stream wire fixture: the SDK, not a stand-in inference implementation, decodes these frames.
function crc(bytes: Buffer) {
  let n = 0xffffffff;
  for (const b of bytes) { n ^= b; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); }
  return (n ^ 0xffffffff) >>> 0;
}
function frame(kind: string, data: unknown) {
  const headers = Buffer.concat(Object.entries({ ':message-type': 'event', ':event-type': kind, ':content-type': 'application/json' }).map(([name, value]) => {
    const n = Buffer.from(name), v = Buffer.from(value), sizes = Buffer.alloc(3);
    sizes[0] = 7; sizes.writeUInt16BE(v.length, 1);
    return Buffer.concat([Buffer.from([n.length]), n, sizes, v]);
  }));
  const payload = Buffer.from(JSON.stringify(data)), out = Buffer.alloc(16 + headers.length + payload.length);
  out.writeUInt32BE(out.length); out.writeUInt32BE(headers.length, 4); out.writeUInt32BE(crc(out.subarray(0, 8)), 8);
  headers.copy(out, 12); payload.copy(out, 12 + headers.length); out.writeUInt32BE(crc(out.subarray(0, -4)), out.length - 4);
  return out;
}
const context = { messages: [{ role: 'user' as const, content: 'fixture', timestamp: 0 }] };

test('pinned Bedrock SDK reads only the selected profile; native callbacks, cancellation and safe errors cross the isolated child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-fixture-'));
  const selected = join(root, 'selected'), decoy = join(root, 'decoy'), trace = join(root, 'trace');
  for (const home of [selected, decoy]) {
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(join(home, '.aws', 'credentials'), `[selected]\naws_access_key_id=${home === selected ? 'SELECTED_ACCESS' : CANARY}\naws_secret_access_key=fixture-secret\n`);
  }
  writeFileSync(trace, '');
  const old = { HOME: process.env.HOME, AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_PROFILE: process.env.AWS_PROFILE, AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK };
  Object.assign(process.env, { HOME: decoy, AWS_ACCESS_KEY_ID: CANARY, AWS_SECRET_ACCESS_KEY: CANARY, AWS_PROFILE: 'selected', AWS_BEARER_TOKEN_BEDROCK: CANARY });
  const originalFork = childProcess.fork;
  // Add only tracing/egress instrumentation to the real child boundary; no SDK or provider is mocked.
  childProcess.fork = ((path: any, args: any, o: any) => {
    assert.equal(o.env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(o.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(o.env.AWS_BEARER_TOKEN_BEDROCK, undefined);
    assert.notEqual(o.env.HOME, decoy);
    return originalFork(path, args, { ...o, env: { ...o.env, TRACE_ROOTS: [selected, decoy].join(':'), TRACE_LOG: trace },
      execArgv: ['--import', traceFs, '--require', new URL('../../../scripts/test-egress-guard.cjs', import.meta.url).pathname] });
  }) as typeof originalFork;
  syncBuiltinESMExports();
  const server = createServer();
  const auth: string[] = [];
  let hold = false;
  server.on('stream', (stream, headers) => {
    auth.push(String(headers.authorization));
    stream.on('error', () => {});
    if (hold) return;
    stream.respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream' });
    stream.end(Buffer.concat([
      frame('messageStart', { role: 'assistant' }),
      frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'cloud fixture' } }),
      frame('messageStop', { stopReason: 'end_turn' }),
      frame('metadata', { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, metrics: { latencyMs: 1 } }),
    ]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const p = builtinProviders().find((p) => p.id === 'amazon-bedrock')!;
  const model = { ...p.getModels()[0], baseUrl: `http://127.0.0.1:${port}` };
  try {
    const a = cloudSelection('aws-bedrock', { ...selections[0][1], home: selected }, host);
    assert.equal(readFileSync(trace, 'utf8'), '');
    let payload = false, response = false;
    const result = await cloudStream(a, undefined, model, context, {
      onPayload: () => { payload = true; }, onResponse: () => { response = true; },
      maxRetries: 0, timeoutMs: 5000,
    }).result();
    assert.equal(result.stopReason, 'stop', JSON.stringify(result));
    assert.equal(result.content[0].type === 'text' && result.content[0].text, 'cloud fixture');
    assert.ok(payload && response);
    assert.match(auth[0], /Credential=SELECTED_ACCESS\//);
    assert.ok(!auth[0].includes(CANARY));
    assert.ok(readFileSync(trace, 'utf8').includes(selected));
    assert.ok(!readFileSync(trace, 'utf8').includes(decoy));
    const error = await cloudStream(a, undefined, model, context, { onPayload: () => { throw new Error(CANARY); } }).result();
    assert.equal(error.stopReason, 'error');
    assert.ok(!JSON.stringify(error).includes(CANARY));
    hold = true;
    const abort = new AbortController();
    const pending = cloudStream(a, undefined, model, context, { signal: abort.signal }).result();
    // Cancellation must also work while startup/credential resolution is in flight.
    abort.abort();
    assert.equal((await pending).stopReason, 'aborted');
    assert.throws(() => cloudStream(a, undefined, { ...model, provider: 'openai' }, context), CloudAccountError);
  } finally {
    childProcess.fork = originalFork; syncBuiltinESMExports();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});
