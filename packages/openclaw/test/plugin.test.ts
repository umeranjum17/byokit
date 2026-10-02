// The shipped bridge plugin (5.9) loaded as the gateway loads it: its before_tool_call hook relays every tool call,
// engine builtins included, to host.gate over a real bridge.
import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bridge, writePlugin } from '../src/bridge.ts';
import type { GateResult, RunRef } from '../src/types.ts';

const shipped = fileURLToPath(new URL('../plugin/index.js', import.meta.url));
const tools = [{ name: 'crew_x', description: 'An app tool.', parameters: { type: 'object' } }];

type Hook = (event: { toolName: string; params?: Record<string, unknown> }, ctx: { sessionKey?: string }) => Promise<unknown>;

async function withPlugin(
  o: { gateBuiltins: boolean; browser?: boolean; capabilities?: string[]; modelAllowed?: boolean; gate: (tool: string, info: { builtin: boolean }) => GateResult },
  fn: (hook: Hook, seen: { gated: [string, { builtin: boolean }][]; called: string[];
    middleware?: (event: { result: any }) => Promise<{ result: any }>; persist?: (event: { message: any }) => { message: any } }) => Promise<void>,
): Promise<void> {
  const dir = scratchDir('plugin');
  const seen: { gated: [string, { builtin: boolean }][]; called: string[];
    middleware?: (event: { result: any }) => Promise<{ result: any }>; persist?: (event: { message: any }) => { message: any } }
    = { gated: [], called: [] };
  copyFileSync(shipped, join(dir, 'index.js'));
  copyFileSync(new URL('../plugin/keys.js', import.meta.url), join(dir, 'keys.js'));
  writePlugin(dir, { id: 'byokit', tools, paramPrefix: '__byokit', gateBuiltins: o.gateBuiltins, browser: o.browser });
  const bridge = new Bridge({
    path: join(dir, 'bridge.sock'),
    ...(o.browser ? { browserCapabilities: () => o.capabilities ?? [], beforeAgentRun: async () => o.modelAllowed !== false } : {}),
    tools: new Set(tools.map((t) => t.name)),
    host: {
      gate: async (_run: RunRef, tool: string, _input: Record<string, unknown>, info: { builtin: boolean }) => {
        seen.gated.push([tool, info]);
        return o.gate(tool, info);
      },
      call: async (_run: RunRef, tool: string) => (seen.called.push(tool), 'ok'),
    },
    permitted: () => true,
    approvalTimeoutMs: 5_000,
    onAsk: () => {},
    onAskGone: () => {},
  });
  await bridge.start();
  bridge.register({ sessionKey: 'agent:m1:x', member: 'm1' });
  bridge.register({ sessionKey: 'agent:byokit-key-m1:x', member: 'm1' });
  const previous = process.env.BYOKIT_BRIDGE_SOCK;
  process.env.BYOKIT_BRIDGE_SOCK = join(dir, 'bridge.sock');
  try {
    const plugin = (await import(pathToFileURL(join(dir, 'index.js')).href)).default;
    let hook: Hook | undefined;
    plugin.register({ registerTool: () => {}, registerAgentToolResultMiddleware: (fn: typeof seen.middleware, options: unknown) => {
      assert.deepEqual(options, { runtimes: ['openclaw', 'codex'] });
      seen.middleware = event => (fn as any)(event, { sessionKey: 'agent:m1:x', runId: 'source-fixture' });
    }, on: (name: string, fn: any) => {
      if (name === 'before_tool_call') hook = fn;
      if (name === 'tool_result_persist') seen.persist = fn;
    } });
    assert.ok(hook, 'the plugin registered no before_tool_call hook');
    await fn(hook, seen);
  } finally {
    if (previous === undefined) delete process.env.BYOKIT_BRIDGE_SOCK;
    else process.env.BYOKIT_BRIDGE_SOCK = previous;
    bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('awaited result middleware removes raw browser capabilities from live content and transcript metadata', async () => {
  const token = 'SYNTHETIC_CDP_TOKEN_FIXTURE';
  const endpoint = `ws://127.0.0.1:1/devtools/browser/fixture?token=${token}`;
  await withPlugin({ gateBuiltins: true, browser: true, capabilities: [endpoint, token], gate: () => ({ allow: true }) }, async (_hook, seen) => {
    assert.ok(seen.middleware); assert.ok(seen.persist);
    const original = { content: [{ type: 'text', text: JSON.stringify({ wsUrl: endpoint, rawToken: token, title: 'Fixture public page' }) },
      { type: 'image', mimeType: 'image/png', data: 'SYNTHETIC_IMAGE_BYTES' }], details: { nested: { endpoint, rawToken: token } } };
    const { result } = await seen.middleware({ result: original });
    assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes(endpoint));
    assert.ok(result.content[0].text.includes('Fixture public page'));
    assert.deepEqual(result.content[1], original.content[1]);
    assert.ok(original.content[0].text?.includes(token), 'does not mutate the input result');
    assert.ok(!JSON.stringify(seen.persist({ message: { role: 'toolResult', ...original } }).message).includes(token));
    const stale = await seen.middleware({ result: { content: [{ type: 'text', text: 'ws://127.0.0.1:1/devtools/page/old?token=old-generation' }] } });
    assert.ok(!stale.result.content[0].text.includes('/devtools/'));
  });
});

test('a parked admission terminates the tool loop without forwarding private output', async () =>
  withPlugin({ gateBuiltins: true, browser: true, modelAllowed: false, gate: () => ({ allow: true }) }, async (_hook, seen) => {
    assert.ok(seen.middleware);
    const { result } = await seen.middleware({ result: { content: [{ type: 'text', text: 'SYNTHETIC_PRIVATE_COOKIE' }] } });
    assert.equal(result.terminate, true);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_COOKIE'));
  }));

test('an invalid capability snapshot terminates rather than falling back to the raw result', async () =>
  withPlugin({ gateBuiltins: true, browser: true, capabilities: [''], gate: () => ({ allow: true }) }, async (_hook, seen) => {
    assert.ok(seen.middleware);
    const { result } = await seen.middleware({ result: { content: [{ type: 'text', text: 'SYNTHETIC_RAW_RESULT' }] } });
    assert.equal(result.terminate, true);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_RAW_RESULT'));
  }));

test('a builtin tool the app never registered is gated and blocked by host.gate', async () =>
  withPlugin({ gateBuiltins: true, gate: () => ({ allow: false, reason: 'no fetching' }) }, async (hook, seen) => {
    const decision = await hook({ toolName: 'web_fetch', params: { url: 'https://example.invalid' } }, { sessionKey: 'agent:m1:x' });
    assert.deepEqual(decision, { block: true, blockReason: 'no fetching' });
    assert.deepEqual(seen.gated, [['web_fetch', { builtin: true }]]);
    assert.deepEqual(seen.called, []);
  }));

test('an allowed builtin passes through unchanged, with no permit and nothing to call back', async () =>
  withPlugin({ gateBuiltins: true, gate: () => ({ allow: true }) }, async (hook, seen) => {
    assert.equal(await hook({ toolName: 'web_search', params: { q: 'x' } }, { sessionKey: 'agent:m1:x' }), undefined);
    assert.deepEqual(seen.gated, [['web_search', { builtin: true }]]);
  }));

test('a builtin without a session key or from an unknown run is blocked', async () =>
  withPlugin({ gateBuiltins: true, gate: () => ({ allow: true }) }, async (hook, seen) => {
    assert.equal((await hook({ toolName: 'web_fetch' }, {}) as { block: boolean }).block, true);
    assert.deepEqual(await hook({ toolName: 'web_fetch' }, { sessionKey: 'agent:m1:other' }), { block: true, blockReason: 'unknown run' });
    assert.deepEqual(seen.gated, []);
  }));

test('an app tool still gets its run key and permit, marked not builtin', async () =>
  withPlugin({ gateBuiltins: true, gate: () => ({ allow: true }) }, async (hook, seen) => {
    const decision = await hook({ toolName: 'crew_x', params: { a: 1 } }, { sessionKey: 'agent:m1:x' }) as { params: Record<string, unknown> };
    assert.equal(decision.params.a, 1);
    assert.equal(decision.params.__byokit_run, 'agent:m1:x');
    assert.equal(typeof decision.params.__byokit_permit, 'string');
    assert.deepEqual(seen.gated, [['crew_x', { builtin: false }]]);
  }));

test('browser guard pins hostile and omitted profiles, nested targets and account-agent routing before app gate', async () =>
  withPlugin({ gateBuiltins: true, browser: true, gate: () => ({ allow: true }) }, async (hook, seen) => {
    for (const profile of [undefined, 'user', 'openclaw', 'chrome', 'byokit-other']) {
      const result = await hook({ toolName: 'browser', params: { action: 'act', profile, node: 'foreign', target: 'node',
        request: { kind: 'click', profile: 'byokit-other', node: 'foreign' }, actions: [{ kind: 'click', target: 'node' }] } },
      { sessionKey: 'agent:byokit-key-m1:x' }) as { params: Record<string, any> };
      assert.equal(result.params.profile, 'byokit-m1'); assert.equal(result.params.target, 'host');
      assert.equal(result.params.node, undefined);
      assert.equal(Object.hasOwn(result.params, 'node'), true, 'stock shallow merge must overwrite the original node');
      assert.equal(({ node: 'foreign', ...result.params }).node, undefined, 'stock before-tool-call merge clears hostile routing');
      assert.equal(result.params.request.profile, 'byokit-m1'); assert.equal(result.params.request.node, undefined);
      assert.equal(result.params.actions[0].target, 'host');
    }
    for (const tool of ['exec', 'process', 'code_execution', 'bash', 'terminal', 'read', 'write', 'edit', 'apply_patch', 'gateway', 'unknown_tool'])
      assert.equal((await hook({ toolName: tool }, { sessionKey: 'agent:m1:x' }) as { block: boolean }).block, true);
    for (const params of [{ action: 'profiles' }, { action: 'importprofile' }, { action: 'start' }, { action: 'stop' },
      { action: 'doctor' }, { action: 'act', request: { kind: 'evaluate', fn: 'document.cookie' } },
      { action: 'act', actions: [{ kind: 'evaluate' }] }])
      assert.equal((await hook({ toolName: 'browser', params }, { sessionKey: 'agent:m1:x' }) as { block: boolean }).block, true);
    assert.equal(seen.gated.length, 5, 'unsafe inputs never reach app approval');
  }));

test('gateBuiltins false lets builtins run ungated and still gates the app tools', async () =>
  withPlugin({ gateBuiltins: false, gate: () => ({ allow: false, reason: 'no' }) }, async (hook, seen) => {
    assert.equal(await hook({ toolName: 'web_fetch', params: {} }, { sessionKey: 'agent:m1:x' }), undefined);
    assert.deepEqual(await hook({ toolName: 'crew_x', params: {} }, { sessionKey: 'agent:m1:x' }), { block: true, blockReason: 'no' });
    assert.deepEqual(seen.gated, [['crew_x', { builtin: false }]]);
  }));
