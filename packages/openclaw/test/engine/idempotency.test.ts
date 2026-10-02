// R2: real pinned engine, loopback scripted provider and a task-owned connection loss, never an account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { scratchDir } from '../../../test-support.ts';
import { releaseStub, startModelStub, stubHolding, useModelStub } from '../../src/testing/model-stub.ts';
import type { GatewayTransport, RunSpec } from '../../src/types.ts';

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('R2: accepted disconnect retries one run; cached inputs are not compared and new nonces dispatch separately', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('r2');
  const stub = await startModelStub();
  const trace: unknown[] = [];
  const sourceHashes: Record<string, string> = {};
  let active!: GatewayTransport;
  let connect!: () => Promise<unknown>;
  let drop = false;
  let disconnected: Promise<void> | undefined;
  const events = new Set<Parameters<GatewayTransport['onEvent']>[0]>();
  const kit = new OpenClawKit({ stateDir, engineDir: process.env.BYOKIT_R2_ENGINE_DIR,
    transport: (ctx) => {
      connect = async () => {
        active = gatewayTransport(ctx);
        active.onEvent((e) => { for (const fn of events) fn(e); });
        const hello = await active.start();
        trace.push({ event: 'connected', version: hello.server.version });
        return hello;
      };
      return {
        start: () => connect() as ReturnType<GatewayTransport['start']>,
        request: async (method, params, options) => {
          if (method === 'agent' || method === 'agent.wait') trace.push({ event: 'request', method, params });
          try {
            const result = await active.request(method, params, { ...options, onAccepted: (payload) => {
              trace.push({ event: 'accepted', payload });
              options?.onAccepted?.(payload);
              if (drop && method === 'agent') {
                drop = false;
                disconnected = active.stop().then(() => { trace.push({ event: 'close', reason: 'task-owned transport stopped after accepted' }); });
              }
            } });
            if (method === 'agent' || method === 'agent.wait') trace.push({ event: 'result', method, result });
            return result;
          } catch (error) {
            trace.push({ event: 'error', method, message: String(error) });
            throw error;
          }
        },
        onEvent: (fn) => (events.add(fn), () => { events.delete(fn); }),
        // This test closes only its connection, not the engine or kit supervisor.
        onClose: () => () => {},
        stop: () => active.stop(),
      };
    },
  });
  const key = 'task:r2:attempt:1:action:one';
  const spec: RunSpec & { idempotencyKey: string } = { member: 'm1', sessionKey: 'agent:m1:r2:one',
    message: 'ask permission', idempotencyKey: key };
  const providerCounts = () => stub.calls.map((c) => ({ path: c.path, messages: c.body.messages }));
  try {
    await kit.start();
    // Source-bound expiry/pressure proof: avoid a five-minute sleep or flooding 1,001 model runs.
    const dist = join(process.env.BYOKIT_R2_ENGINE_DIR ?? join(stateDir, 'openclaw', 'engine'), 'node_modules/openclaw/dist');
    const source = (name: string) => {
      const text = readFileSync(join(dist, name), 'utf8');
      sourceHashes[name] = createHash('sha256').update(text).digest('hex');
      return text;
    };
    const maintenance = source('server-maintenance-NppRBWD2.js');
    assert.match(maintenance, /now - v\.ts > 3e5/);
    assert.match(maintenance, /params\.dedupe\.size > 1e3/);
    assert.match(maintenance, /isActiveRunDedupeKey\(k, v\) \|\| isPendingAcceptedRunDedupeKey\(k, v\)/);
    assert.match(maintenance, /\}, 6e4\)/);
    assert.match(source('server-constants-DKuFNbQH.js'), /DEDUPE_MAX = 1e3/);
    source('principal-CA42B2iA.js');
    source('primitives-TdbrOFJ1.js');
    await useModelStub(kit, stub);
    await kit.ensureMember('m1');
    await kit.ensureMember('m2');
    drop = true;
    const lost = await kit.run(spec);
    assert.equal(lost.ok, false, JSON.stringify(lost));
    await disconnected;
    await until(() => stubHolding());
    const before = stub.calls.length;
    assert.equal(before, 1, 'one accepted dispatch reached the provider');
    await connect();
    trace.push({ event: 'retry', key });
    const text = JSON.stringify({ report: 'x'.repeat(1500) });
    const retry = kit.run({ ...spec, schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] } });
    await until(() => trace.some((e: any) => e.event === 'result' && e.method === 'agent' && e.result?.status === 'in_flight'));
    releaseStub(undefined, text);
    const end = await retry;
    assert.ok(end.ok, JSON.stringify(end));
    assert.equal(end.text, text, 'cached reattachment returns the wait snapshot (this answer fits its cap)');
    assert.deepEqual(end.data, JSON.parse(text));
    assert.equal('usage' in end, false, 'in-flight replay has no final frame: no invented usage');
    assert.equal(stub.calls.length, before, 'same key made no second provider dispatch');
    assert.deepEqual(trace.filter((e: any) => e.event === 'accepted').map((e: any) => e.payload.runId), [key]);
    assert.ok(trace.some((e: any) => e.event === 'result' && e.method === 'agent' && e.result?.runId === key
      && e.result?.status === 'in_flight'), 'retry attached to the identical engine run');
    // Engine scope is method + key, NOT member/session; changed input silently returns the first result.
    const collision = await kit.run({ ...spec, member: 'm2', sessionKey: 'agent:m2:r2:collision', message: 'different input' });
    assert.ok(collision.ok && collision.text === text, JSON.stringify(collision));
    assert.equal(stub.calls.length, before);
    const other = await kit.run({ ...spec, sessionKey: 'agent:m1:r2:two', message: 'new action', idempotencyKey: key + ':two' });
    assert.ok(other.ok, JSON.stringify(other));
    assert.equal(stub.calls.length, before + 1, 'a different action nonce dispatches independently');
    // The map belongs to the gateway process: reconnect retained it, a process restart does not.
    await kit.stop();
    await kit.start();
    const restarted = await kit.run({ ...spec, sessionKey: 'agent:m1:r2:restart', message: 'after process restart' });
    assert.ok(restarted.ok && restarted.text !== text, JSON.stringify(restarted));
    assert.equal(stub.calls.length, before + 2, 'process restart loses dedupe; the same key dispatches again');
    // A cached provider failure is replayed, not attempted again. Last: the engine applies an auth/billing cooldown.
    const bad = { ...spec, sessionKey: 'agent:m1:r2:error', message: 'no helpers in plan', idempotencyKey: key + ':error' };
    const failed = await kit.run(bad);
    assert.equal(failed.ok, false);
    const failures = stub.calls.length;
    assert.deepEqual(await kit.run(bad), failed);
    assert.equal(stub.calls.length, failures, 'same key replays the prior error without billing another attempt');
    trace.push({ event: 'provider-counts', sameKey: before, differentNonce: before + 1, afterRestart: before + 2,
      withFailure: failures });
  } finally {
    releaseStub();
    await kit.stop();
    await stub.close();
    const receipt = { engine: '2026.8.1', key, sourceHashes, trace, providerCalls: providerCounts() };
    writeFileSync(join(stateDir, 'r2-trace.json'), JSON.stringify(receipt, null, 2));
    if (process.env.BYOKIT_R2_TRACE) writeFileSync(process.env.BYOKIT_R2_TRACE, JSON.stringify(receipt, null, 2));
  }
});
