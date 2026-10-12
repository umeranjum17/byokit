// The OpenCode Go plan-key route binds a member handle for consumers such as decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, memoryStore, ResponseError } from '../src/index.ts';

const CANARY = 'canary-plan-key-opencode-go';

function local() {
  const saved = new Map<string, string>();
  return new Accounts({ store: () => memoryStore(), keyStore: () => ({
    get: async (id: string) => saved.get(id) ?? null,
    set: async (id: string, value: string) => { saved.set(id, value); },
    delete: async (id: string) => saved.delete(id),
    list: async () => [],
  }) });
}

test('a saved Go plan key binds a subscription handle that hands only its own key', async () => {
  const accounts = local();
  const { id, signIn } = await accounts.add('Umer', 'opencode:plan_key:opencode-go', { key: CANARY });
  assert.ok(id.startsWith('opencode:plan_key:opencode-go.'));
  assert.equal(signIn?.state, 'done');
  const handle = accounts.opencodeGo('Umer');
  assert.equal(handle.billing, 'subscription');
  assert.equal(await handle.access(new AbortController().signal), CANARY);
  // A second member's handle reads only their own key; a stranger has none to hand.
  const other = local();
  await other.add('Luis', 'opencode:plan_key:opencode-go', { key: 'luis-plan-key' });
  assert.equal(await other.opencodeGo('Luis').access(new AbortController().signal), 'luis-plan-key');
  assert.equal(await accounts.opencodeGo('Umer').access(new AbortController().signal), CANARY);
  await assert.rejects(other.opencodeGo('Umer').access(new AbortController().signal),
    (e) => e instanceof ResponseError && e.kind === 'signed_out');
});
