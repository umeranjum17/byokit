import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeys } from '../src/keys.ts';
import type { GatewayTransport } from '../src/types.ts';

test('key readiness retries a restart refusal without replaying activation or choosing another account', async () => {
  const calls: string[] = [];
  const keys = createKeys({ root: '/unused', ensure: async () => ({ agentId: 'm1' }),
    request: (async (method) => {
      calls.push(method);
      if (calls.length === 1) throw Object.assign(new Error('gateway restarting'), { code: 'UNAVAILABLE', retryable: true });
      return { ok: true, model: 'openai/test' };
    }) as GatewayTransport['request'] });
  assert.deepEqual(await keys.ready('m1'), { agentId: 'byokit-key-m1', model: 'openai/test' });
  assert.deepEqual(calls, ['byokit.keys', 'byokit.keys']);
});

test('missing and terminally refused key reads fail closed immediately and never expose error contents', async () => {
  for (const result of [null, { ok: false }, { code: 'UNAVAILABLE', retryable: false }]) {
    let calls = 0;
    const keys = createKeys({ root: '/unused', ensure: async () => ({ agentId: 'm1' }),
      request: (async () => {
        calls++;
        if (result && 'ok' in result) return result;
        throw Object.assign(new Error('CANARY-ERROR-KEY'), result);
      }) as GatewayTransport['request'] });
    assert.equal(await keys.ready('m1'), undefined);
    assert.equal(calls, 1);
  }
});

test('key readiness waits while the kit reconnects after activation', async () => {
  let attempts = 0;
  let restarting = true;
  const keys = createKeys({ root: '/unused', ensure: async () => ({ agentId: 'm1' }),
    restarting: () => restarting,
    request: (async () => {
      attempts++;
      if (attempts === 1) throw new Error('gateway not ready');
      restarting = false;
      return { ok: true, model: 'openai/test' };
    }) as GatewayTransport['request'] });
  assert.deepEqual(await keys.ready('m1'), { agentId: 'byokit-key-m1', model: 'openai/test' });
  assert.equal(attempts, 2);
});
