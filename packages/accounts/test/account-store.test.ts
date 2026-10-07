import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, ResponseError, WORDS, callbackPage, memoryStore, recordStore, viewStore, type AuthHost, type Platform } from '../src/portable.ts';
import { mockOpenAI } from '../src/testing/index.ts';
import type { Record as CredentialRecord } from '../src/stores.ts';
import { connect, pairWithOffer, startHost } from '../../pair/test/helpers.ts';
import type { Credential } from '@earendil-works/pi-ai';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/account-identities-typescript.json', import.meta.url), 'utf8'));

test('WP1: different ChatGPT identity adds, same identity replaces; independent use, defaults and legacy login', async () => {
  const mock = await mockOpenAI({ email: 'umer@example.com' });
  const store = memoryStore();
  const a = new Accounts({ store: (member) => member === fixture.member ? store : memoryStore(), authBase: mock.base });
  const member = fixture.member;
  const connected: string[] = [];
  a.onSignedIn = (_member, id) => connected.push(id);
  try {
    let work = '';
    let old: Credential | undefined;
    let addedAt = 0;
    for (const [n, identity] of fixture.identities.entries()) {
      Object.assign(mock.state, identity);
      const added = await a.add(member, 'chatgpt', { via: 'code' });
      assert.equal((await a.list(member)).length, n === 0 ? 0 : n === 1 ? 1 : 2, 'staged additions stay out of list');
      mock.approve(added.signIn!.code!);
      await a.finished(member, added.id);
      const canonical = a.view(member, added.id)!.id!;
      const rows = await a.list(member);
      assert.equal(rows.length, identity.expectedCount);
      assert.equal(a.view(member, added.id)!.state, 'done');
      if (n === 0) assert.equal(canonical, fixture.firstId);
      if (n === 1) {
        work = canonical;
        assert.match(work, new RegExp(fixture.additionalId));
        await a.rename(member, work, 'Work');
        await a.setDefaults(member, { account: work, model: 'chosen-model', auto: false });
        old = await store.read(work);
        addedAt = rows.find((r) => r.id === work)!.addedAt;
      }
      if (n === 2) {
        assert.equal(canonical, work);
        assert.equal(rows.find((r) => r.id === work)!.name, 'Work');
        assert.equal(rows.find((r) => r.id === work)!.addedAt, addedAt);
        assert.notEqual((await store.read(work) as any).refresh, (old as any).refresh);
        assert.equal((await a.defaults(member)).account, work);
      }
    }
    for (const id of ['openai-codex', work]) await store.modify(id, async (c) => c?.type === 'oauth' ? { ...c, expires: 0 } : undefined);
    const personal = await a.access(member, undefined, 'chatgpt');
    const business = await a.access(member, undefined, work);
    assert.equal(personal.accountId, 'umer-personal');
    assert.equal(business.accountId, 'umer-work');
    assert.notEqual(personal.access, business.access);
    assert.equal((await a.access(member)).accountId, 'umer-work', 'legacy provider uses its default');
    const runtime = await a.runtime(member, work);
    assert.deepEqual((await runtime.credentialStore.list()).map((r) => r.providerId), ['openai-codex']);
    assert.equal((await runtime.readCredential('openai-codex') as any).accountId, 'umer-work');
    assert.equal((await a.list('Other member')).length, 0);
    await a.failed(member, 'chatgpt', '503 overloaded');
    assert.ok(a.restingUntil(member, 'chatgpt') > Date.now(), 'legacy rest follows the default account');
    assert.equal((await a.list(member)).find((r) => r.id === 'chatgpt')!.state, 'ready', 'first account remains independent');
    assert.equal((await a.list(member)).find((r) => r.id === work)!.state, 'resting');
    a.notIncluded(member, 'chatgpt', true);
    assert.equal(a.unready(member, 'chatgpt'), true);
    assert.equal(a.notIncluded(member, work), true);
    a.notIncluded(member, 'chatgpt', false);
    a.forget(member, 'chatgpt');
    assert.equal(a.unready(member, 'chatgpt'), true);
    assert.equal((await a.list(member)).find((r) => r.id === 'chatgpt')!.state, 'ready');
    const legacy = await a.login(member, 'chatgpt', { via: 'code' });
    mock.approve(legacy!.code!);
    await a.finished(member, 'chatgpt');
    assert.equal(a.view(member, 'chatgpt')!.state, 'done');
    assert.equal((await a.list(member)).length, 2);
    assert.deepEqual(connected.slice(0, 3), ['chatgpt', work, work]);
    await a.remove(member, 'chatgpt');
    assert.deepEqual((await a.list(member)).map((r) => r.id), [work]);
    assert.equal((await a.defaults(member)).account, work);
    assert.equal((await a.access(member, undefined, work)).accountId, 'umer-work');
    await a.remove(member, work);
    assert.equal((await a.list(member)).length, 0);
    assert.equal((await a.defaults(member)).account, undefined);
  } finally { a.stop(); await mock.close(); }
});

test('ChatGPT host access refuses another provider before opening its credential runtime', async () => {
  const store = memoryStore();
  const secret = 'WP1-other-provider-secret';
  for (const id of ['xai', 'grok.12345678']) await store.modify(id, async () => ({ type: 'oauth', access: secret, refresh: secret, expires: Date.now() + 864_000_000, accountId: 'umer-grok' }));
  let engines = 0; let authCalls = 0;
  const platform: Platform = {
    signsIn: () => true,
    engine: (credentials) => {
      engines++;
      return {
        credentialStore: credentials, readCredential: (id: string) => credentials.read(id),
        getAuth: async () => { authCalls++; return { auth: { apiKey: secret } }; },
      } as unknown as AuthHost;
    },
  };
  const a = new Accounts({ offer: ['chatgpt', 'grok'], store: () => store }, platform);
  try {
    for (const id of ['grok', 'grok.12345678']) {
      await assert.rejects(a.access('Umer', undefined, id), (error: Error) => error instanceof ResponseError && error.kind === 'not_included' && !error.message.includes(secret));
      assert.equal(engines, 0, 'refusal precedes opening another provider credential runtime');
      assert.equal(authCalls, 0, 'refusal precedes getAuth');
    }
  } finally { a.stop(); }
});

test('failed and cancelled additions leave existing credentials intact', async () => {
  const mock = await mockOpenAI({ email: 'umer@example.com' });
  const store = memoryStore();
  const a = new Accounts({ store: () => store, authBase: mock.base });
  try {
    const first = await a.login('Umer', 'chatgpt');
    mock.approve(first!.code!);
    await a.finished('Umer', 'chatgpt');
    const original = await store.read('openai-codex');
    const next = await a.add('Umer', 'chatgpt');
    mock.approve(next.signIn!.code!, true);
    await a.finished('Umer', next.id);
    assert.equal(a.view('Umer', next.id)!.state, 'failed');
    assert.deepEqual(await store.read('openai-codex'), original);
    const cancelled = await a.add('Umer', 'chatgpt');
    a.cancel('Umer', cancelled.id);
    await a.finished('Umer', cancelled.id);
    assert.deepEqual(await store.read('openai-codex'), original);
    assert.equal((await a.list('Umer')).length, 1);
  } finally { a.stop(); await mock.close(); }
});

test('two-account secret canary: list, status, words, index, errors and rendered link output', async () => {
  const secret = 'WP1-secret-canary-never-public';
  let data: CredentialRecord = {};
  const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  const token = { type: 'oauth' as const, access: secret, refresh: secret, expires: Date.now() + 864_000_000 };
  await store.modify('openai-codex', async () => ({ ...token, accountId: 'umer-personal' }));
  await store.modify('chatgpt.12345678', async () => ({ ...token, accountId: 'umer-work' }));
  const a = new Accounts({ store: () => store });
  await a.rename('Umer', 'chatgpt.12345678', 'Work');
  const rows = await a.list('Umer');
  const statuses = await Promise.all(rows.map((r) => a.status('Umer', r.id)));
  const h = await startHost({ name: 'Umer', handle: async () => ({ rows: await a.list('Umer'), statuses }) });
  let linkOutput: unknown;
  try {
    const device = connect(await pairWithOffer(h.host.offer({ role: 'view', urls: [h.url] }).text, { name: 'Umer' }));
    try { linkOutput = await device.link.request('get.accounts'); }
    finally { device.link.stop(); }
  } finally { h.stop(); }
  const publicOutput = JSON.stringify({ rows, statuses, words: WORDS, index: data['.accounts'], linkOutput, page: callbackPage('Umer', statuses[0].words) });
  assert.equal(publicOutput.includes(secret), false);
  assert.deepEqual(Object.keys(data['.accounts']!).sort(), fixture.index.toSorted());
  assert.equal((await store.list()).some((r) => r.providerId.startsWith('.')), false);
  assert.equal(await store.read('.accounts'), undefined);
  const view = viewStore(store, 'openai-codex', 'chatgpt.12345678');
  assert.equal((await view.read('openai-codex') as any).accountId, 'umer-work');
  await assert.rejects(async () => view.read('chatgpt.12345678'), (e: Error) => !e.message.includes(secret));
  await assert.rejects(a.rename('Umer', 'chatgpt.87654321', 'Missing'), (e: Error) => !e.message.includes(secret));
});

test('fresh catalogue parameter and process-wide loopback reservation; second sign-in uses code', async () => {
  let listeners = 0;
  let attempts = 0;
  const platform: Platform = {
    signsIn: () => true,
    loopback: async () => { listeners++; return { close: () => { listeners--; } }; },
    engine: (credentials) => ({
      credentialStore: credentials,
      readCredential: (id: string) => credentials.read(id),
      logout: (id: string) => credentials.delete(id),
      checkAuth: async (id: string) => await credentials.read(id) ? { type: 'oauth', source: 'OAuth' } : undefined,
      getAuth: async () => undefined,
      login: async (id: string, _type: string, interaction: any) => {
        const n = ++attempts;
        const mode = await interaction.prompt({ type: 'select', options: [{ id: 'browser' }, { id: 'device' }] });
        if (mode === 'device') interaction.notify({ type: 'device_code', userCode: 'FAKE', verificationUri: 'https://example.test/code' });
        else {
          interaction.notify({ type: 'auth_url', url: 'https://example.test/signin?state=fake' });
          await interaction.prompt({ type: 'paste' });
        }
        const c = { type: 'oauth' as const, access: 'fake', refresh: 'fake', expires: Date.now() + 864_000_000, accountId: `umer-${n}` };
        await credentials.modify(id, async () => c);
        return c;
      },
    } as unknown as AuthHost),
  };
  const first = new Accounts({ offer: ['chatgpt'], callbackPort: 21345, store: () => memoryStore() }, platform);
  const second = new Accounts({ offer: ['chatgpt'], callbackPort: 21345, store: () => memoryStore() }, platform);
  try {
    const one = await first.add('Umer', 'chatgpt');
    assert.equal(new URL(one.signIn!.url!).searchParams.get('prompt'), 'login');
    assert.equal(listeners, 1);
    const two = await second.add('Umer', 'chatgpt');
    assert.equal(two.signIn!.via, 'code');
    await second.finished('Umer', two.id);
    assert.equal(listeners, 1);
    first.paste('Umer', one.id, 'done');
    await first.finished('Umer', one.id);
    assert.equal(listeners, 0);
  } finally { first.stop(); second.stop(); }
});


test('cancelling during an addition commit restores both the previous credential and index', async () => {
  const mock = await mockOpenAI({ email: 'umer@example.com' });
  let data: CredentialRecord = {};
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let delay = false;
  const store = recordStore(async () => structuredClone(data), async (next) => {
    if (delay && Object.keys(next).some((id) => !id.startsWith('.'))) { delay = false; entered(); await gate; }
    data = structuredClone(next);
  });
  const a = new Accounts({ store: () => store, authBase: mock.base });
  try {
    const first = await a.login('Umer', 'chatgpt');
    mock.approve(first!.code!);
    await a.finished('Umer', 'chatgpt');
    const added = await a.add('Umer', 'chatgpt');
    const done = a.finished('Umer', added.id);
    const before = structuredClone(data);
    delay = true;
    mock.approve(added.signIn!.code!);
    await writing;
    a.cancel('Umer', added.id);
    release();
    await done;
    assert.deepEqual(data, before);
    assert.equal((await a.list('Umer')).length, 1);
  } finally { release(); a.stop(); await mock.close(); }
});


test('portable addition and legacy login work without structuredClone or a global crypto shim', async () => {
  const mock = await mockOpenAI({ email: 'umer@example.com' });
  const clone = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone')!;
  const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const a = new Accounts({ store: () => memoryStore(), authBase: mock.base });
  try {
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    const added = await a.add('Umer', 'chatgpt');
    mock.approve(added.signIn!.code!);
    await a.finished('Umer', added.id);
    assert.equal(a.view('Umer', added.id)!.id, 'chatgpt');
    const legacy = await a.login('Umer', 'chatgpt');
    mock.approve(legacy!.code!);
    await a.finished('Umer', 'chatgpt');
    assert.equal(a.view('Umer', 'chatgpt')!.state, 'done');
    assert.equal((await a.list('Umer')).length, 1);
  } finally {
    Object.defineProperty(globalThis, 'structuredClone', clone);
    Object.defineProperty(globalThis, 'crypto', crypto);
    a.stop(); await mock.close();
  }
});


test('a rejected addition save cannot mutate a host-owned record returned directly by load', async () => {
  const mock = await mockOpenAI({ email: 'umer@example.com' });
  let data: CredentialRecord = {};
  let reject = false;
  const store = recordStore(async () => data, async (next) => {
    if (reject) throw new Error('Storage is unavailable.');
    data = next;
  });
  const a = new Accounts({ store: () => store, authBase: mock.base });
  try {
    const first = await a.login('Umer', 'chatgpt');
    mock.approve(first!.code!);
    await a.finished('Umer', 'chatgpt');
    const added = await a.add('Umer', 'chatgpt');
    const before = structuredClone(data);
    reject = true;
    mock.approve(added.signIn!.code!);
    await a.finished('Umer', added.id);
    assert.equal(a.view('Umer', added.id)!.state, 'failed');
    assert.deepEqual(data, before);
  } finally { a.stop(); await mock.close(); }
});
