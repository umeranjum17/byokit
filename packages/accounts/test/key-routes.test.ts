import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, recordStore, type AccountMetadata } from '../src/portable.ts';
import type { Record as CredentialRecord } from '../src/stores.ts';
import type { Keystore } from '@byokit/secrets';

const canary = 'B2-exact-secret-canary-987654321';
function secrets(): Keystore {
  const data = new Map<string, string>();
  return { get: async (id) => data.get(id) ?? null, set: async (id, value) => { data.set(id, value); }, delete: async (id) => data.delete(id) };
}

test('shared key seam persists only a marker and non-secret route metadata; updates retain metadata', async () => {
  let data: CredentialRecord = {};
  const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  class Adapter extends Accounts {
    save(id: string, metadata: AccountMetadata) { return this.saveAccountKey('member', id, canary, metadata); }
  }
  const keyStore = secrets();
  const a = new Adapter({ store: () => store, keyStore: () => keyStore });
  const metadata = { route: 'openai:key', billing: 'api', baseUrl: 'https://app.example/v1' } as const;
  await a.save('one', metadata);
  await store.index((index) => { index.names.one = 'One'; });
  assert.deepEqual((await store.index()).accounts?.one, metadata);
  assert.deepEqual(await store.read('one'), { type: 'api_key' });
  assert.equal(await keyStore.get('accounts.one'), canary);
  assert.ok(!JSON.stringify(data).includes(canary));
});
