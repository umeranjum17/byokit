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
  o: { gateBuiltins: boolean; gate: (tool: string, info: { builtin: boolean }) => GateResult },
  fn: (hook: Hook, seen: { gated: [string, { builtin: boolean }][]; called: string[] }) => Promise<void>,
): Promise<void> {
  const dir = scratchDir('plugin');
  const seen = { gated: [] as [string, { builtin: boolean }][], called: [] as string[] };
  copyFileSync(shipped, join(dir, 'index.js'));
  copyFileSync(new URL('../plugin/keys.js', import.meta.url), join(dir, 'keys.js'));
  writePlugin(dir, { id: 'byokit', tools, paramPrefix: '__byokit', gateBuiltins: o.gateBuiltins });
  const bridge = new Bridge({
    path: join(dir, 'bridge.sock'),
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
  const previous = process.env.BYOKIT_BRIDGE_SOCK;
  process.env.BYOKIT_BRIDGE_SOCK = join(dir, 'bridge.sock');
  try {
    const plugin = (await import(pathToFileURL(join(dir, 'index.js')).href)).default;
    let hook: Hook | undefined;
    plugin.register({ registerTool: () => {}, on: (name: string, fn: Hook) => { if (name === 'before_tool_call') hook = fn; } });
    assert.ok(hook, 'the plugin registered no before_tool_call hook');
    await fn(hook, seen);
  } finally {
    if (previous === undefined) delete process.env.BYOKIT_BRIDGE_SOCK;
    else process.env.BYOKIT_BRIDGE_SOCK = previous;
    bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test('gateBuiltins false lets builtins run ungated and still gates the app tools', async () =>
  withPlugin({ gateBuiltins: false, gate: () => ({ allow: false, reason: 'no' }) }, async (hook, seen) => {
    assert.equal(await hook({ toolName: 'web_fetch', params: {} }, { sessionKey: 'agent:m1:x' }), undefined);
    assert.deepEqual(await hook({ toolName: 'crew_x', params: {} }, { sessionKey: 'agent:m1:x' }), { block: true, blockReason: 'no' });
    assert.deepEqual(seen.gated, [['crew_x', { builtin: false }]]);
  }));
