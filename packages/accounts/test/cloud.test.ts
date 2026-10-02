import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http2';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { Context, Tool } from '@earendil-works/pi-ai';
import { createServer as httpServer } from 'node:http';
import { unsignedForwarder } from '../src/cloud-worker.ts';
import { route } from '../src/catalogue.ts';
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
      assert.throws(() => cloudSelection(provider, { ...options, get key(): string { throw new Error('credential touched'); } }, { platform }),
        (e: unknown) => e instanceof CloudAccountError && e.code === 'unsupported_platform');
    }
  }
  const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/cloud-accounts-typescript.json', import.meta.url), 'utf8'));
  assert.equal(fixture.ownership.B3.length + fixture.ownership.B4.length, 6);
  for (const row of fixture.cases) {
    const a = cloudSelection(row.provider, row.options, host);
    for (const name of row.metadata) assert.equal((a as any)[name], row.options[name]);
  }
  assert.throws(() => cloudSelection('aws-bedrock', { route: 'aws-bedrock:cloud:credential-chain', via: 'cloud', region: 'us-east-1' }, host), CloudAccountError);
  assert.throws(() => cloudSelection('azure', { route: 'azure:key', via: 'key', key: CANARY, baseUrl: `https://${CANARY}@fixture.invalid` }, host), CloudAccountError);
  assert.throws(() => cloudSelection('cloudflare', { route: 'cloudflare:key:cloudflare-workers-ai', via: 'key', key: CANARY, accountId: '../another' }, host), CloudAccountError);
  const skip = route('aws-bedrock:endpoint:skip-auth', host);
  assert.equal(skip.upstream.flow, 'present');
  assert.equal(skip.readiness, 'ready');
  assert.equal(skip.via, 'endpoint');
  assert.throws(() => cloudSelection('aws-bedrock', { ...selections[9][1], get key(): string { throw new Error('secret touched'); } }, host),
    (e: unknown) => e instanceof CloudAccountError && e.code === 'invalid_selection');
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

test('save/list/default/remove never probe SDK files, ambient credentials, bindings or the network', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'cloud-add-'));
  const script = `
    import assert from 'node:assert/strict';
    import { Accounts, portable, recordStore, CloudAccountError } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    import { resolveSelection } from ${JSON.stringify(new URL('../src/multi.ts', import.meta.url).href)};
    let record = {}, calls = 0;
    const saved = new Map();
    const store = recordStore(async () => structuredClone(record), async (next) => { record = structuredClone(next); });
    const secrets = { get: async (id) => saved.get(id) ?? null, set: async (id, value) => { saved.set(id, value); }, delete: async (id) => saved.delete(id) };
    const accounts = new Accounts({ store: () => store, keyStore: () => secrets, cloudBinding: () => { calls++; throw new Error('binding probed'); } });
    const selections = ${JSON.stringify(selections)};
    for (const [provider, options] of selections) {
      if (options.home) options.home = ${JSON.stringify(join(root, 'selected-but-unread'))};
      if (options.keyFile) options.keyFile = ${JSON.stringify(join(root, 'selected-but-unread', 'service.json'))};
      const { id } = await accounts.add('member', provider, options);
      assert.ok(await accounts.signedIn('member', id));
      assert.equal((await accounts.status('member', id)).state, 'ready');
      const listed = await accounts.list('member');
      assert.ok(!JSON.stringify([listed, record, await accounts.defaults('member')]).includes(${JSON.stringify(CANARY)}));
      const choice = resolveSelection(listed, {}, { account: 'auto' }, () => ({ left: 'unknown' }), 0);
      assert.equal(choice.ok, false);
      await accounts.rename('member', id, 'Chosen account');
      await accounts.setDefaults('member', { account: id });
      await accounts.remove('member', id);
      assert.equal((await accounts.list('member')).length, 0);
    }
    const binding = await accounts.addCloud('member', 'cloudflare', { via: 'cloud', route: 'cloudflare:cloud:workers-binding', binding: 'selected-AI', gatewayId: 'fixture', baseUrl: 'https://workers-binding.ai/ai-gateway/gateways/fixture/openai' });
    assert.equal((await accounts.list('member'))[0].state, 'ready');
    await accounts.setDefaults('member', { account: binding.id });
    assert.equal(calls, 0);
    await accounts.remove('member', binding.id);
    const phone = new Accounts({ store: () => { throw new Error('storage touched'); }, keyStore: () => { throw new Error('keys touched'); } }, portable);
    await assert.rejects(phone.addCloud('member', 'azure', { route: 'azure:key', via: 'key', get key() { throw new Error('key touched'); } }), (e) => e instanceof CloudAccountError && e.code === 'unsupported_platform');
    process.stdout.write('isolated-cloud-ok');
  `;
  try {
    const output = childProcess.execFileSync(process.execPath, ['--permission', `--allow-fs-read=${repo}`, '--require', join(repo, 'scripts/test-egress-guard.cjs'), '--input-type=module', '-e', script], {
      env: { HOME: join(root, 'decoy'), NODE_OPTIONS: '', AWS_PROFILE: CANARY, AWS_ACCESS_KEY_ID: CANARY, AWS_SECRET_ACCESS_KEY: CANARY, GOOGLE_APPLICATION_CREDENTIALS: join(root, CANARY), CLOUDFLARE_API_KEY: CANARY }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(output, 'isolated-cloud-ok');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native cloud key/binding streams keep the selected endpoint and redact public errors', async () => {
  const p = builtinProviders().find((p) => p.id === 'cloudflare-workers-ai')!;
  const m = { ...p.getModels()[0], api: 'openai-completions' as const };
  const completion = () => new Response([
    { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
    { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const bindingAccount = cloudSelection('cloudflare', { via: 'cloud', route: 'cloudflare:cloud:workers-binding', binding: 'AI', gatewayId: 'fixture', baseUrl: 'https://workers-binding.ai/ai-gateway/gateways/fixture/openai' }, host);
  let sends = 0;
  const result = await cloudStream(bindingAccount, undefined, { ...m, provider: 'cloudflare-ai-gateway' }, context, {}, {
    aiGatewayLogId: null,
    fetch: async (input, init) => {
      sends++;
      const request = input instanceof Request ? input : new Request(input, init);
      assert.ok(request.url.startsWith(bindingAccount.baseUrl!));
      const headers = request.headers;
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('x-api-key'), null);
      assert.equal(headers.get('cf-aig-authorization'), 'Bearer cloudflare-gateway-binding');
      return completion();
    },
  }).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(sends, 1);
  const selected = cloudSelection('cloudflare', selections[7][1], host);
  const answered = await cloudStream(selected, CANARY, m, context, { maxRetries: 0, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(request.headers.get('authorization'), `Bearer ${CANARY}`);
    return completion();
  } }).result();
  assert.equal(answered.stopReason, 'stop');
  const failed = await cloudStream(selected, CANARY, m, context, { maxRetries: 0, fetch: async () => { throw new Error(CANARY); } }).result();
  assert.equal(failed.stopReason, 'error');
  assert.ok(!JSON.stringify(failed).includes(CANARY));
  const azure = cloudSelection('azure', selections[6][1], host);
  const azureModel = builtinProviders().find((p) => p.id === 'azure-openai-responses')!.getModels()[0];
  const response = await cloudStream(azure, CANARY, azureModel, context, { maxRetries: 0, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.ok(request.url.startsWith(azure.baseUrl!));
    const headers = request.headers;
    assert.ok(headers.get('api-key') === CANARY || headers.get('authorization') === `Bearer ${CANARY}`);
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } }).result();
  assert.equal(response.stopReason, 'stop');
});

test('unsigned Converse uses the real isolated child, fixed-target streaming and no signing at egress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unsigned-fixture-'));
  const decoy = join(root, 'decoy'), trace = join(root, 'trace');
  mkdirSync(join(decoy, '.aws'), { recursive: true });
  writeFileSync(join(decoy, '.aws', 'credentials'), `[default]\naws_access_key_id=${CANARY}\naws_secret_access_key=${CANARY}\n`);
  writeFileSync(trace, '');
  const old = { HOME: process.env.HOME, AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_PROFILE: process.env.AWS_PROFILE };
  Object.assign(process.env, { HOME: decoy, AWS_ACCESS_KEY_ID: CANARY, AWS_SECRET_ACCESS_KEY: CANARY, AWS_PROFILE: CANARY });
  const originalFork = childProcess.fork;
  childProcess.fork = ((path: any, args: any, options: any) => {
    assert.notEqual(options.env.HOME, decoy);
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'NODE_OPTIONS']) assert.equal(options.env[name], undefined);
    return originalFork(path, args, { ...options, env: { ...options.env, TRACE_ROOTS: decoy, TRACE_LOG: trace },
      execArgv: ['--import', traceFs, '--require', new URL('../../../scripts/test-egress-guard.cjs', import.meta.url).pathname] });
  }) as typeof originalFork;
  syncBuiltinESMExports();
  const wire: { url: string; headers: Record<string, any>; body: any }[] = [];
  let mode: 'ok' | 'error' | 'hold' | 'cut' | 'retry' = 'ok';
  let held = () => {}, heldClosed = () => {}, cut = () => {};
  const server = httpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      wire.push({ url: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (mode === 'error' || mode === 'retry') {
        res.writeHead(mode === 'error' ? 400 : 503, { 'content-type': 'application/json', 'x-amzn-errortype': mode === 'error' ? 'ValidationException' : 'ServiceUnavailableException' });
        res.end(JSON.stringify({ message: CANARY })); return;
      }
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream', 'x-gateway': 'fixture', 'x-amzn-requestid': 'fixture-request', upgrade: 'h2,h2c', connection: 'Upgrade' });
      if (mode === 'hold' || mode === 'cut') {
        res.write(frame('messageStart', { role: 'assistant' }));
        if (mode === 'hold') { req.socket.once('close', heldClosed); held(); }
        else cut = () => req.socket.destroy();
        return;
      }
      res.end(Buffer.concat([
        frame('messageStart', { role: 'assistant' }),
        frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'hi ' } }),
        frame('contentBlockStop', { contentBlockIndex: 0 }),
        frame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'lookup' } } }),
        frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"q":"x"}' } } }),
        frame('contentBlockStop', { contentBlockIndex: 1 }),
        frame('messageStop', { stopReason: 'tool_use' }),
        frame('metadata', { usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12, cacheReadInputTokens: 2 } }),
      ]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(server.address() as { port: number }).port}/gw/prefix`;
  const a = cloudSelection('aws-bedrock', { ...selections[9][1], baseUrl: target }, host);
  const model = builtinProviders().find((p) => p.id === 'amazon-bedrock')!.getModels()[0];
  const toolContext: Context = { ...context, tools: [{ name: 'lookup', description: 'fixture', parameters: { type: 'object', properties: { q: { type: 'string' } } } as Tool['parameters'] }] };
  try {
    let payload = false, response = false;
    const stream = cloudStream(a, undefined, model, toolContext, {
      temperature: 0.2, maxTokens: 64, maxRetries: 0, headers: { 'x-team': 'chosen', 'x-api-key': 'fixture-custom', Authorization: 'Bearer must-not-egress' },
      onPayload: (value) => { payload = !!(value as any).toolConfig; return { ...(value as any), requestMetadata: { tag: 'chosen' } }; },
      onResponse: async (r) => { response = r.headers['x-gateway'] === 'fixture'; },
    });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(result.stopReason, 'toolUse');
    assert.ok(events.includes('toolcall_end'));
    assert.deepEqual(result.content.find((c) => c.type === 'toolCall')?.arguments, { q: 'x' });
    assert.deepEqual([result.usage.input, result.usage.output, result.usage.cacheRead], [5, 7, 2]);
    assert.ok(payload && response);
    assert.match(wire[0].url, /^\/gw\/prefix\/model\/[^/?#]+\/converse-stream$/);
    assert.equal(wire[0].body.inferenceConfig.temperature, 0.2);
    assert.equal(wire[0].body.requestMetadata.tag, 'chosen');
    assert.equal(wire[0].headers['x-team'], 'chosen');
    assert.equal(wire[0].headers['x-api-key'], 'fixture-custom');
    for (const name of ['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256']) assert.equal(wire[0].headers[name], undefined);
    assert.equal(readFileSync(trace, 'utf8'), '');
    assert.ok(!JSON.stringify(wire).includes(CANARY));
    mode = 'error';
    const error = await cloudStream(a, undefined, model, context, { maxRetries: 0 }).result();
    assert.equal(error.stopReason, 'error');
    assert.ok(!JSON.stringify(error).includes(CANARY));
    mode = 'cut';
    const cutResult = await cloudStream(a, undefined, model, context, { maxRetries: 0, timeoutMs: 3000, onResponse: () => cut() }).result();
    assert.equal(cutResult.stopReason, 'error');
    mode = 'hold';
    const arrived = new Promise<void>((resolve) => { held = resolve; });
    const closed = new Promise<void>((resolve) => { heldClosed = resolve; });
    const abort = new AbortController();
    const pending = cloudStream(a, undefined, model, context, { maxRetries: 0, signal: abort.signal, timeoutMs: 3000 }).result();
    await arrived; abort.abort();
    assert.equal((await pending).stopReason, 'aborted');
    await closed;
    mode = 'retry';
    const before = wire.length;
    assert.equal((await cloudStream(a, undefined, model, context, { maxRetries: 2 }).result()).stopReason, 'error');
    assert.equal(wire.length - before, 3);
    assert.throws(() => cloudStream(a, CANARY, model, context), CloudAccountError);
    assert.throws(() => cloudStream(a, undefined, model, context, { bearerToken: CANARY } as any), CloudAccountError);
    assert.throws(() => cloudStream(a, undefined, model, context, { profile: CANARY } as any), CloudAccountError);
    assert.throws(() => cloudSelection('aws-bedrock', { ...selections[9][1], profile: CANARY }, host), CloudAccountError);
    assert.throws(() => cloudSelection('aws-bedrock', { ...selections[9][1], baseUrl: `http://${CANARY}@127.0.0.1` }, host), CloudAccountError);
    const gate = await unsignedForwarder(target);
    try {
      const prior = wire.length;
      for (const [suffix, auth] of [['/wrong/model/model/converse-stream', 'AWS4-HMAC-SHA256 Credential=dummy-access-key/fixture'], [`/${new URL(gate.baseUrl).pathname.split('/')[1]}/model/model/converse-stream`, 'Bearer real'], [`/${new URL(gate.baseUrl).pathname.split('/')[1]}//other.invalid`, 'AWS4-HMAC-SHA256 Credential=dummy-access-key/fixture']]) {
        const response = await fetch(new URL(suffix, gate.baseUrl), { method: 'POST', headers: { authorization: auth } });
        assert.equal(response.status, 403);
      }
      assert.equal(wire.length, prior);
    } finally { gate.close(); }
  } finally {
    childProcess.fork = originalFork; syncBuiltinESMExports();
    for (const [name, value] of Object.entries(old)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('pinned Bedrock SDK reads only the selected profile; native callbacks, cancellation and safe errors cross the isolated child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-fixture-'));
  const selected = join(root, 'selected'), decoy = join(root, 'decoy'), trace = join(root, 'trace');
  for (const home of [selected, decoy]) {
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(join(home, '.aws', 'credentials'), `[selected]\naws_access_key_id=${home === selected ? 'SELECTED_ACCESS' : CANARY}\naws_secret_access_key=fixture-secret\n`);
  }
  writeFileSync(trace, '');
  const diagnosticFile = join(root, 'sdk-error.json');
  const diagnosticLoader = join(root, 'diagnostic.mjs');
  writeFileSync(diagnosticLoader, `import { AssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))};
import { writeFileSync } from 'node:fs';
const push = AssistantMessageEventStream.prototype.push;
AssistantMessageEventStream.prototype.push = function(event) {
  if (event.type === 'error') writeFileSync(${JSON.stringify(diagnosticFile)}, JSON.stringify(event.error));
  return push.call(this, event);
};`);
  const old = { HOME: process.env.HOME, AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_PROFILE: process.env.AWS_PROFILE, AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK };
  Object.assign(process.env, { HOME: decoy, AWS_ACCESS_KEY_ID: CANARY, AWS_SECRET_ACCESS_KEY: CANARY, AWS_PROFILE: 'selected', AWS_BEARER_TOKEN_BEDROCK: CANARY });
  const originalFork = childProcess.fork;
  let diagnostic = '';
  // Add only tracing/egress instrumentation to the real child boundary; no SDK or provider is mocked.
  childProcess.fork = ((path: any, args: any, o: any) => {
    assert.equal(o.env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(o.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(o.env.AWS_BEARER_TOKEN_BEDROCK, undefined);
    assert.notEqual(o.env.HOME, decoy);
    const child = originalFork(path, args, { ...o, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...o.env, TRACE_ROOTS: [selected, decoy].join(':'), TRACE_LOG: trace },
      execArgv: ['--import', traceFs, '--import', diagnosticLoader, '--require', new URL('../../../scripts/test-egress-guard.cjs', import.meta.url).pathname] });
    child.stderr!.on('data', (data) => { diagnostic += data; });
    child.on('exit', (code, signal) => { diagnostic += ` child-exit=${code}/${signal}`; });
    child.on('message', (message) => { if ((message as any).failed) diagnostic += ' sdk-failed-ipc'; });
    return child;
  }) as typeof originalFork;
  syncBuiltinESMExports();
  const server = createServer();
  const auth: string[] = [];
  let hold = false;
  let waitForConsumer = true;
  let finishResponse = () => {};
  let onHeldRequest = () => {};
  server.on('stream', (stream, headers) => {
    auth.push(String(headers.authorization));
    stream.on('error', () => {});
    stream.resume();
    stream.on('end', () => {
      if (hold) { onHeldRequest(); return; }
      stream.respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream' });
      const beginning = Buffer.concat([frame('messageStart', { role: 'assistant' }), frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'cloud fixture' } })]);
      const ending = Buffer.concat([frame('messageStop', { stopReason: 'end_turn' }), frame('metadata', { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, metrics: { latencyMs: 1 } })]);
      if (waitForConsumer) { stream.write(beginning); finishResponse = () => stream.end(ending); }
      else stream.end(Buffer.concat([beginning, ending]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const p = builtinProviders().find((p) => p.id === 'amazon-bedrock')!;
  const model = { ...p.getModels()[0], baseUrl: `http://127.0.0.1:${port}` };
  try {
    const a = cloudSelection('aws-bedrock', { ...selections[0][1], home: selected }, host);
    assert.equal(readFileSync(trace, 'utf8'), '');
    let payload = false, response = false;
    const asked = cloudStream(a, undefined, model, context, {
      onPayload: () => { payload = true; }, onResponse: async () => { response = true; },
      maxRetries: 0, timeoutMs: 5000,
    });
    for await (const event of asked) if (event.type === 'text_delta') finishResponse();
    const result = await asked.result();
    if (result.stopReason !== 'stop') {
      try { diagnostic += readFileSync(diagnosticFile, 'utf8'); } catch {}
      writeFileSync(join(process.env.TMPDIR!, '..', 'cloud-private-diagnostic.log'), diagnostic);
    }
    assert.equal(result.stopReason, 'stop', diagnostic || JSON.stringify(result));
    assert.equal(result.content[0].type === 'text' && result.content[0].text, 'cloud fixture');
    assert.ok(payload && response);
    waitForConsumer = false;
    assert.match(auth[0], /Credential=SELECTED_ACCESS\//);
    assert.ok(!auth[0].includes(CANARY));
    assert.ok(readFileSync(trace, 'utf8').includes(selected));
    assert.ok(!readFileSync(trace, 'utf8').includes(decoy));
    // Stock placeholder control needs the same sealed environment as the real worker: the SDK has its own
    // ambient bearer resolver even when Pi skipAuth is set. Keep the hostile parent CANARY outside this child.
    const controlHome = join(root, 'stock-control');
    mkdirSync(controlHome);
    const controlEnv = { HOME: controlHome, USERPROFILE: controlHome, APPDATA: join(controlHome, '.config'), AWS_REGION: 'us-east-1', AWS_BEDROCK_SKIP_AUTH: '1', AWS_EC2_METADATA_DISABLED: 'true' };
    const control = childProcess.spawn(process.execPath, ['--input-type=module', '--require', new URL('../../../scripts/test-egress-guard.cjs', import.meta.url).pathname, '--eval', `
      import { stream } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai/api/bedrock-converse-stream'))};
      import { normalizeContext } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))};
      const result = await stream(${JSON.stringify(model)}, normalizeContext(${JSON.stringify(context)}), { region: 'us-east-1', maxRetries: 0 }).result();
      console.log(result.stopReason);
    `], { env: controlEnv, stdio: ['ignore', 'pipe', 'ignore'] });
    let controlResult = '';
    control.stdout.on('data', (chunk) => { controlResult += chunk; });
    const controlExit = await new Promise<number | null>((resolve, reject) => { control.once('error', reject); control.once('close', resolve); });
    assert.equal(controlExit, 0);
    assert.equal(controlResult.trim(), 'stop');
    assert.equal(process.env.AWS_BEARER_TOKEN_BEDROCK, CANARY, 'hostile parent stays unchanged');
    assert.match(auth[1], /Credential=dummy-access-key\//, 'sealed stock skip-auth still signs with placeholder credentials');
    writeFileSync(join(process.env.TMPDIR!, '..', 'stock-placeholder-013.json'), JSON.stringify({ env: controlEnv, parentBearerPreserved: true, result: controlResult.trim(), requestPin: 'AWS4-HMAC-SHA256 Credential=dummy-access-key/', target: model.baseUrl }, null, 2));
    assert.throws(() => cloudStream({ route: 'aws-bedrock:endpoint:skip-auth', provider: 'aws-bedrock', upstream: 'amazon-bedrock', method: 'skip-auth', billing: 'api' }, undefined, model, context), CloudAccountError);
    const error = await cloudStream(a, undefined, model, context, { onPayload: () => { throw new Error(CANARY); } }).result();
    assert.equal(error.stopReason, 'error');
    assert.ok(!JSON.stringify(error).includes(CANARY));
    const chosenFile = join(selected, 'service.json');
    writeFileSync(chosenFile, JSON.stringify({ type: 'deliberately-invalid-fixture' }));
    const vertex = cloudSelection('google-vertex', { ...selections[4][1], keyFile: chosenFile }, host);
    const vertexModel = builtinProviders().find((p) => p.id === 'google-vertex')!.getModels()[0];
    const invalidADC = await cloudStream(vertex, undefined, vertexModel, context, { maxRetries: 0 }).result();
    assert.equal(invalidADC.stopReason, 'error');
    assert.ok(readFileSync(trace, 'utf8').includes(chosenFile));
    assert.ok(!readFileSync(trace, 'utf8').includes(decoy));
    hold = true;
    const arrived = new Promise<void>((resolve) => { onHeldRequest = resolve; });
    const abort = new AbortController();
    const pending = cloudStream(a, undefined, model, context, { signal: abort.signal, timeoutMs: 5000 }).result();
    await arrived;
    abort.abort();
    assert.equal((await pending).stopReason, 'aborted');
    assert.throws(() => cloudStream(a, undefined, { ...model, provider: 'openai' }, context), CloudAccountError);
  } finally {
    childProcess.fork = originalFork; syncBuiltinESMExports();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});
