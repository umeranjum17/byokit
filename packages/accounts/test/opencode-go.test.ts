// The OpenCode Go plan-key route binds a member handle for consumers such as decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, memoryStore, ResponseError } from '../src/index.ts';
import { offered, planKey, provider, route, signInChoices } from '../src/catalogue.ts';
import { portable } from '../src/accounts.ts';

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

test('the catalogue offers OpenCode Go as a pasted plan key, on phones and browsers too', async () => {
  const p = provider('opencode');
  assert.deepEqual([p.pi, p.name, p.company, p.billing, p.auth], ['opencode-go', 'OpenCode Go', 'OpenCode', 'subscription', 'api-key']);
  assert.ok(p.offer !== false && (!p.readiness || p.readiness === 'ready'), 'a default subscription offer');
  assert.ok(p.models.strong, 'names its strong model for the picker');
  assert.deepEqual(p.routes, ['opencode:plan_key:opencode-go']);
  assert.ok(offered().some((q) => q.key === 'opencode'), 'in the default offer');
  assert.ok(!signInChoices().some((q) => q.key === 'opencode'), 'no device flow, so never in the device picker');
  assert.equal(planKey('opencode-go'), true);
  assert.equal(planKey('minimax'), false, 'an absent upstream flow is not a pasted key');
  assert.equal(planKey('openai-codex'), false, 'a device flow is not a pasted key');
  const go = route('opencode:plan_key:opencode-go', { platform: 'browser' });
  assert.deepEqual([go.readiness, go.billing, go.offer], ['ready', 'subscription', 'default']);
  const portableKit = new Accounts({ store: () => memoryStore() }, portable);
  assert.ok(portableKit.providers.some((q) => q.key === 'opencode'), 'a phone or browser card exists for it');
  assert.equal((await portableKit.status(1, 'opencode')).state, 'signed_out');
  // OAuth is refused: the only way in is the key route.
  await assert.rejects(portableKit.login(1, 'opencode'), /through its key route/);
  const saved = new Map<string, string>();
  const keyed = new Accounts({ store: () => memoryStore(), keyStore: () => ({
    get: async (id: string) => saved.get(id) ?? null,
    set: async (id: string, value: string) => { saved.set(id, value); },
    delete: async (id: string) => saved.delete(id),
    list: async () => [],
  }) }, portable);
  const { id } = await keyed.add(1, 'opencode:plan_key:opencode-go', { key: CANARY });
  assert.ok(id.startsWith('opencode:plan_key:opencode-go.'));
  assert.equal((await keyed.status(1, 'opencode')).state, 'ready', 'the provider resolves to its saved key account');
  assert.deepEqual((await keyed.list(1)).map((a) => [a.provider, a.state]), [['opencode', 'ready']]);
  await keyed.logout(1, 'opencode');
  assert.equal((await keyed.status(1, 'opencode')).state, 'signed_out');
  assert.deepEqual([...saved], [], 'sign-out removes the saved key');
});
