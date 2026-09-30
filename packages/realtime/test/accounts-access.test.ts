import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, memoryStore } from '../../accounts/src/portable.ts';
import { mockOpenAI } from '../../accounts/src/testing/index.ts';
test('accounts host access refreshes the app sign-in and handles missing, revoked and aborted access', async t => {
  const openai = await mockOpenAI({ email: 'umer@example.com' }); t.after(() => openai.close());
  const store = memoryStore();
  const accounts = new Accounts<any, number>({ store: () => store, authBase: openai.base });
  await assert.rejects(accounts.access(1));
  const login = (await accounts.login(1, 'chatgpt'))!; openai.approve(login.code!); await accounts.finished(1, 'chatgpt');
  const before = await accounts.access(1); assert.equal(before.accountId, 'acct-1');
  await store.modify('openai-codex', async credential => credential?.type === 'oauth' ? { ...credential, expires: 0 } : credential);
  const fresh = await accounts.access(1); assert.notEqual(fresh.access, before.access);
  await store.modify('openai-codex', async credential => credential?.type === 'oauth' ? { ...credential, expires: 0 } : credential);
  openai.state.refuse = true; await assert.rejects(accounts.access(1));
  const controller = new AbortController(); controller.abort(); await assert.rejects(accounts.access(1, controller.signal));
  await accounts.logout(1, 'chatgpt'); await assert.rejects(accounts.access(1));
});
