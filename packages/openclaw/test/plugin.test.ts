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
import { browserSessionMayRun } from '../src/config.ts';
import type { NeedSignIn, ResumeState } from '../src/browser.ts';

const shipped = fileURLToPath(new URL('../plugin/index.js', import.meta.url));
const tools = [{ name: 'crew_x', description: 'An app tool.', parameters: { type: 'object' } }];

type Hook = (event: { toolName: string; params?: Record<string, unknown> }, ctx: { sessionKey?: string }) => Promise<unknown>;
type Middleware = (event: { result: any }, ctx?: { sessionKey?: string; runId?: string }) => Promise<{ result: any }>;

async function withPlugin(
  o: { gateBuiltins: boolean; browser?: boolean; capabilities?: string[]; modelAllowed?: boolean; admission?: (key: string, runId?: string) => boolean; gate: (tool: string, info: { builtin: boolean }) => GateResult },
  fn: (hook: Hook, seen: { gated: [string, { builtin: boolean }][]; called: string[];
    middleware?: Middleware; persist?: (event: { message: any }) => { message: any } }) => Promise<void>,
): Promise<void> {
  const dir = scratchDir('plugin');
  const seen: { gated: [string, { builtin: boolean }][]; called: string[];
    middleware?: Middleware; persist?: (event: { message: any }) => { message: any } }
    = { gated: [], called: [] };
  copyFileSync(shipped, join(dir, 'index.js'));
  copyFileSync(new URL('../plugin/keys.js', import.meta.url), join(dir, 'keys.js'));
  copyFileSync(new URL('../plugin/usage.js', import.meta.url), join(dir, 'usage.js'));
  writePlugin(dir, { id: 'byokit', tools, paramPrefix: '__byokit', gateBuiltins: o.gateBuiltins, browser: o.browser });
  const bridge = new Bridge({
    path: join(dir, 'bridge.sock'),
    ...(o.browser ? { browserCapabilities: () => o.capabilities ?? [], beforeAgentRun: async (key, runId) => o.admission ? o.admission(key, runId) : o.modelAllowed !== false } : {}),
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
    const methods: string[] = [];
    plugin.register({ registerGatewayMethod: (name: string) => methods.push(name), registerTool: () => {}, registerAgentToolResultMiddleware: (fn: typeof seen.middleware, options: unknown) => {
      assert.deepEqual(options, { runtimes: ['openclaw', 'codex'] });
      seen.middleware = (event, ctx = { sessionKey: 'agent:m1:x', runId: 'source-fixture' }) => (fn as any)(event, ctx);
    }, on: (name: string, fn: any) => {
      if (name === 'before_tool_call') hook = fn;
      if (name === 'tool_result_persist') seen.persist = fn;
    } });
    assert.ok(methods.includes('byokit.usage.engineStarted'), 'Workshop accounting remains registered alongside browser protection');
    assert.ok(methods.includes('byokit.keys'), 'key registration remains available');
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

test('source matrix: held/parked and recovered records stop private outputs while unrelated sessions remain usable', async () => {
  const key = 'agent:m1:x';
  let policyReady = true;
  let row = { sessionKey: key, state: 'waiting' } as NeedSignIn;
  const options = { gateBuiltins: true, browser: true, capabilities: ['GENERATION_ONE_SYNTHETIC_TOKEN'],
    admission: (session: string) => policyReady && browserSessionMayRun([row], session),
    gate: (): GateResult => ({ allow: true }) };
  await withPlugin(options, async (_hook, seen) => {
    assert.ok(seen.middleware);
    const secret = { content: [{ type: 'text', text: 'PRIVATE_COOKIE PRIVATE_PAGE PRIVATE_PROFILE PRIVATE_TARGET PRIVATE_LEASE' }],
      details: { privateCookie: 'PRIVATE_COOKIE' } };
    for (const state of ['waiting', 'held', 'checking', 'parked'] as const) {
      row = { sessionKey: key, state } as NeedSignIn;
      const stopped: any = (await seen.middleware({ result: secret })).result;
      assert.equal(stopped.terminate, true, state);
      assert.ok(!JSON.stringify(stopped).includes('PRIVATE_'), state);
      const publicResult = (await seen.middleware({ result: { content: [{ type: 'text', text: 'PUBLIC_UNRELATED_SESSION' }] } },
        { sessionKey: 'agent:other:fixture', runId: 'unrelated' })).result;
      assert.ok(publicResult.content[0].text.includes('PUBLIC_UNRELATED_SESSION'));
      assert.notEqual(publicResult.terminate, true);
    }
    for (const state of ['pending', 'accepted', 'submitted', 'indeterminate', 'failed'] as ResumeState['state'][]) {
      // Restored state representation only: this is NOT a process restart or resume dispatch observation.
      row = { sessionKey: key, state: 'settled', settled: { resume: { state } } } as NeedSignIn;
      for (const runId of [undefined, 'foreign', 'previous-engine-request']) {
        const stopped: any = (await seen.middleware({ result: secret }, { sessionKey: key, runId })).result;
        assert.equal(stopped.terminate, true, `recovered ${state}/${runId}`);
        assert.ok(!JSON.stringify(stopped).includes('PRIVATE_'));
      }
    }
    row = { sessionKey: key, state: 'settled' } as NeedSignIn;
    policyReady = false;
    assert.equal((await seen.middleware({ result: secret })).result.terminate, true, 'recovering/unacknowledged policy');
    policyReady = true;
    options.capabilities.push('GENERATION_TWO_SYNTHETIC_TOKEN');
    const afterRotation = (await seen.middleware({ result: { content: [{ type: 'text',
      text: 'GENERATION_ONE_SYNTHETIC_TOKEN GENERATION_TWO_SYNTHETIC_TOKEN PUBLIC_ROTATED_RESULT' }] } })).result;
    assert.ok(!JSON.stringify(afterRotation).includes('SYNTHETIC_TOKEN'));
    assert.ok(afterRotation.content[0].text.includes('PUBLIC_ROTATED_RESULT'));
    assert.notEqual(afterRotation.terminate, true);
  });
});

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
