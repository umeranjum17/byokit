// OpenCode Go plan decisions: the plan account answers over the shared Responses wire format,
// billed to the member's Go plan only. Fake fetch below; the live test at the bottom runs one real
// question on the desktop Go sign-in and skips cleanly without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { ConfigError, decide, openai, opencodeGo, OPENCODE_GO_ROUTES, parseConfig, UnsupportedAccountError, UnsupportedImagesError,
  InvalidImageError, type ImageInput, type Question } from '../src/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/openai-responses.json', import.meta.url), 'utf8'));
const questions: Record<string, Question> = {
  intent: { kind: 'choice', options: {
    task: 'Something new to do', followup: 'About an earlier job', chat: 'Just talking' } },
  urgent: { kind: 'yesno', question: 'Urgent?' },
  rating: { kind: 'score', levels: ['low', 'medium', 'high'] },
};
const account = (token = 'plan-token') => ({ provider: 'opencode-go' as const, billing: 'subscription' as const, access: async () => token });

test('an app decides on an OpenCode Go plan account over the Responses endpoint, plan-billed only', async () => {
  assert.deepEqual(OPENCODE_GO_ROUTES, { apiKey: { billing: 'subscription', offer: false },
    account: { billing: 'subscription', offer: true, consentRequired: true } });
  let calls = 0;
  let sent: any;
  const backend = opencodeGo({ model: 'muse-spark-1.3-contributor', account: account(), fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://opencode.ai/zen/go/v1/responses');
    assert.equal((init!.headers as any).authorization, 'Bearer plan-token');
    assert.ok(typeof (init!.headers as any)['x-opencode-session'] === 'string', 'Go routes on a conversation session');
    sent = JSON.parse(init!.body as string);
    return Response.json(fixture.completed);
  } });
  assert.equal(backend.name, 'opencode-go');
  const result = await decide({}, questions, { privacy: 'may-leave', backends: [backend] });
  assert.equal(calls, 1);
  assert.deepEqual([result.intent.answer, result.urgent.answer, result.rating.answer], ['followup', true, 2]);
  for (const a of Object.values(result)) {
    assert.equal(a.by, 'opencode-go');
    assert.equal(a.confidenceSource, 'self-reported');
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, fixture.completed);
  }
  assert.equal(sent.model, 'muse-spark-1.3-contributor');
  assert.ok(!('store' in sent) && !('stream' in sent), 'no ChatGPT-plan request flags cross to Go');
  assert.equal(sent.text.format.strict, true);
  assert.deepEqual(sent.text.format.schema.properties.rating.properties.pick.enum, ['0', '1', '2']);

  // A refusal, a cut-off reply and malformed JSON abstain while keeping usage and the raw response.
  for (const response of [fixture.refusal, fixture.incomplete,
    { ...fixture.completed, output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] }]) {
    const a = (await decide({}, { intent: questions.intent }, { privacy: 'may-leave',
      backends: [opencodeGo({ model: 'muse-spark-1.3-contributor', account: account(),
        fetch: async () => Response.json(response) })] })).intent;
    assert.equal(a.abstained, true);
    assert.deepEqual(a.usage, { input_tokens: 84, output_tokens: 67 });
    assert.deepEqual(a.raw, response);
  }

  // A 429 retries on the same plan route with the same session, then answers; a refused plan status never bills a key.
  let tries = 0;
  const sessions = new Set<string>();
  const retried = await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [opencodeGo({
    model: 'muse-spark-1.3-contributor', account: account(), fetch: async (_url, init) => {
      sessions.add((init!.headers as any)['x-opencode-session']);
      return ++tries === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json(fixture.completed);
    },
  })] });
  assert.equal(retried.intent.answer, 'followup');
  assert.equal(tries, 2);
  assert.equal(sessions.size, 1, 'retries keep one conversation session');
  await assert.rejects(decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [opencodeGo({
    model: 'muse-spark-1.3-contributor', account: account(), fetch: async () => new Response('', { status: 401 }),
  })] }), UnsupportedAccountError);
});

test('an account with a workspace names it on every Go call; a bare key sends no workspace header', async () => {
  const orgs: (string | undefined)[] = [];
  const workspaceAccount = { ...account(), workspace: async () => 'org_WORKING2' };
  await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [opencodeGo({
    model: 'muse-spark-1.3-contributor', account: workspaceAccount, fetch: async (_url, init) => {
      orgs.push((init!.headers as any)['x-opencode-org-id']);
      return Response.json(fixture.completed);
    },
  })] });
  await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [opencodeGo({
    model: 'muse-spark-1.3-contributor', account: account(), fetch: async (_url, init) => {
      orgs.push((init!.headers as any)['x-opencode-org-id']);
      return Response.json(fixture.completed);
    },
  })] });
  assert.deepEqual(orgs, ['org_WORKING2', undefined], 'the stored workspace rides the call, a bare key stays headerless');
});

test('a host holding the plain Go plan key decides without the accounts peer, still plan-billed', async () => {
  let sent: any;
  const backend = opencodeGo({ model: 'muse-spark-1.3-contributor', key: 'plan-key', fetch: async (url, init) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/responses');
    assert.equal((init!.headers as any).authorization, 'Bearer plan-key');
    assert.ok(typeof (init!.headers as any)['x-opencode-session'] === 'string', 'the key path keeps the conversation session');
    sent = JSON.parse(init!.body as string);
    return Response.json(fixture.completed);
  } });
  const result = await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [backend] });
  assert.equal(result.intent.answer, 'followup');
  assert.equal(result.intent.by, 'opencode-go');
  assert.equal(result.intent.confidenceSource, 'self-reported');
  assert.deepEqual(result.intent.usage, { input_tokens: 84, output_tokens: 67 });
  assert.ok(!JSON.stringify(result).includes('plan-key'), 'the plan key never lands in an answer');
  assert.equal(sent.model, 'muse-spark-1.3-contributor');

  // A key and an account together are refused; a refused plan status never bills another route.
  assert.throws(() => opencodeGo({ model: 'm', key: 'k', account: account() } as any), /not both/);
  for (const bad of ['', '  ', 42] as any[]) assert.throws(() => opencodeGo({ model: 'm', key: bad }), /needs a key/);
  const refusedKey = await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [opencodeGo({
    model: 'muse-spark-1.3-contributor', key: 'plan-key', fetch: async () => new Response('', { status: 401 }),
  })] });
  assert.equal(refusedKey.intent.abstained, true);
  assert.equal(refusedKey.intent.reason, 'opencode-go failed: http 401');
});

test('a misplaced plan handle is refused on both providers, naming the provider, with no fallback', async () => {
  const { chatgptPlan } = await import('../../accounts/src/chatgpt-plan.ts');
  const chatgpt = chatgptPlan({ session: async () => ({ accessToken: 'chatgpt-token',
    scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] }) });
  assert.equal(chatgpt.provider, 'chatgpt');
  assert.throws(() => opencodeGo({ model: 'muse-spark-1.3-contributor', account: chatgpt as any }),
    /This is a chatgpt plan account; pass it on the chatgpt route/);

  const { Accounts, memoryStore } = await import('../../accounts/src/index.ts');
  const saved = new Map<string, string>();
  const accounts = new Accounts({ store: () => memoryStore(), keyStore: () => ({
    get: async (id: string) => saved.get(id) ?? null,
    set: async (id: string, value: string) => { saved.set(id, value); },
    delete: async (id: string) => saved.delete(id),
    list: async () => [],
  }), fetch: async () => new Response('', { status: 401 }) }); // the console refuses: a key with no workspace
  await accounts.add('Umer', 'opencode:plan_key:opencode-go', { key: 'member-plan-key' });
  const go = accounts.opencodeGo('Umer');
  assert.equal(go.provider, 'opencode-go');
  assert.throws(() => openai({ auth: 'account', account: go as any, model: 'gpt-6.1-sol' }),
    /This is a opencode-go plan account; pass it on the opencode-go route/);

  // Untagged token handles from an older @byokit/accounts are refused on both routes and never sent anywhere.
  const legacyChatGPT = { billing: 'subscription', access: async () => 'legacy-token' };
  assert.throws(() => openai({ auth: 'account', account: legacyChatGPT as any, model: 'gpt-6.1-sol' }),
    /update @byokit\/accounts/);
  const legacyGo = { billing: 'subscription', access: async () => 'legacy-token' };
  assert.throws(() => opencodeGo({ model: 'muse-spark-1.3-contributor', account: legacyGo as any }),
    /update @byokit\/accounts/);
  const legacyRespond = { billing: 'subscription', respond: async () => ({}) };
  assert.throws(() => openai({ auth: 'account', account: legacyRespond as any, model: 'gpt-6.1-sol' }),
    /update @byokit\/accounts/);
  assert.throws(() => parseConfig({ backend: 'opencode-go', model: 'muse-spark-1.3-contributor', supportsImages: true }),
    ConfigError);
});

test('the Go backend needs a subscription plan account and surfaces a signed-out plan without a key fallback', async () => {
  for (const bad of [undefined, null, { billing: 'subscription' }, { billing: 'api', access: async () => 'k' },
    { billing: 'subscription', access: 'plan-token' },
    { provider: 'chatgpt', billing: 'subscription', access: async () => 'k' }] as any[]) {
    assert.throws(() => opencodeGo({ model: 'muse-spark-1.3-contributor', account: bad }), UnsupportedAccountError);
  }
  assert.throws(() => opencodeGo({ model: '  ', account: account() }), /explicit model/);
  let fetched = 0;
  // A plan that cannot hand a key abstains before any request, and never substitutes another route.
  const signedOut = { provider: 'opencode-go' as const, billing: 'subscription' as const, access: async () => { throw new Error('signed out'); } };
  const fellBack = await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [opencodeGo({
    model: 'muse-spark-1.3-contributor', account: signedOut, fetch: async () => { fetched++; throw new Error('must not fetch'); },
  })] });
  assert.equal(fellBack.intent.abstained, true);
  assert.equal(fetched, 0);

  // Images cross the vision adapter as named content parts; a text-only backend and a malformed image are refused before dispatch.
  const shot: ImageInput = { id: 'shot', mime: 'image/png', bytes: new Uint8Array([1]) };
  const vision: Record<string, Question> = { readable: { kind: 'yesno', question: 'Readable?', images: ['shot'] } };
  const seen = opencodeGo({ model: 'muse-spark-1.3-contributor', account: account(), supportsImages: true,
    fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.deepEqual(body.input[0].content.slice(1), [{ type: 'input_text', text: 'Image: shot' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQ==', detail: 'auto' }]);
      return Response.json({ status: 'completed', usage: { input_tokens: 8, output_tokens: 3 }, output: [{ type: 'message',
        content: [{ type: 'output_text', text: '{"readable":{"probabilities":{"true":0.9,"false":0.1},"pick":"true","rationale":"Clear type."}}' }] }] });
    } });
  const read = await decide({}, vision, { privacy: 'may-leave', backends: [seen], images: [shot] });
  assert.deepEqual([read.readable.answer, read.readable.rationale], [true, 'Clear type.']);
  const textOnly = opencodeGo({ model: 'muse-spark-1.3-contributor', account: account(), fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(decide({}, vision, { privacy: 'may-leave', backends: [textOnly], images: [shot] }), UnsupportedImagesError);
  await assert.rejects(decide({}, vision, { privacy: 'may-leave', backends: [seen], images: [{ ...shot, bytes: new Uint8Array() }] }), InvalidImageError);
});

test('the accounts peer binds the member’s saved Go plan key for the backend', async () => {
  const { Accounts, memoryStore } = await import('../../accounts/src/index.ts');
  const saved = new Map<string, string>();
  const accounts = new Accounts({ store: () => memoryStore(), keyStore: () => ({
    get: async (id: string) => saved.get(id) ?? null,
    set: async (id: string, value: string) => { saved.set(id, value); },
    delete: async (id: string) => saved.delete(id),
    list: async () => [],
  }), fetch: async () => new Response('', { status: 401 }) }); // the console refuses: a key with no workspace
  const { id } = await accounts.add('Umer', 'opencode:plan_key:opencode-go', { key: 'member-plan-key' });
  assert.ok(id.startsWith('opencode:plan_key:opencode-go.'));
  const handle = accounts.opencodeGo('Umer');
  assert.equal(handle.billing, 'subscription');
  assert.deepEqual(Object.keys(handle).sort(), ['access', 'billing', 'provider', 'workspace']);
  assert.equal(await handle.workspace!(new AbortController().signal), '', 'a key the console refused needs no workspace');
  assert.equal(await handle.access(new AbortController().signal), 'member-plan-key');
  let sent: any;
  const result = await decide({}, { intent: questions.intent }, { privacy: 'may-leave', backends: [opencodeGo({
    model: 'muse-spark-1.3-contributor', account: handle, fetch: async (_url, init) => {
      sent = init!.headers;
      return Response.json(fixture.completed);
    } })] });
  assert.equal(result.intent.answer, 'followup');
  assert.equal(sent.authorization, 'Bearer member-plan-key');
  assert.ok(!JSON.stringify(result).includes('member-plan-key'), 'the plan key never lands in an answer');
});

test('the Go backend bundles for phones without runtime SDK, Node or ambient credentials', async () => {
  const bundle = await build({ stdin: { contents: `
    import { decide, opencodeGo } from '../src/index.ts';
    const backend = opencodeGo({ model: 'muse-spark-1.3-contributor',
      account: { provider: 'opencode-go', billing: 'subscription', access: async () => 'phone-plan-key' },
      fetch: async () => Response.json({ status: 'completed', usage: { input_tokens: 4, output_tokens: 8 },
        output: [{ type: 'message', content: [{ type: 'output_text',
          text: JSON.stringify({ urgent: { probabilities: { true: 0.9, false: 0.1 }, pick: 'true', rationale: 'Fire.' } }) }] }] }) });
    globalThis.result = decide({}, { urgent: { kind: 'yesno', question: 'Urgent?' } },
      { privacy: 'may-leave', backends: [backend] });`,
    resolveDir: import.meta.dirname, sourcefile: 'phone-opencode-go.ts' }, bundle: true, platform: 'browser',
    conditions: ['react-native'], format: 'iife', write: false, metafile: true, logLevel: 'silent' });
  assert.deepEqual(Object.keys(bundle.metafile!.inputs).filter((f) => /node:|node_modules\/openai\//.test(f)), []);
  const sandbox: any = { setTimeout, clearTimeout, AbortController, Response };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const { urgent } = await sandbox.result;
  assert.equal(urgent.answer, true);
  assert.equal(urgent.by, 'opencode-go');
  assert.equal(urgent.confidenceSource, 'self-reported');
});

/** The desktop OpenCode sign-in holds the Go plan key (`opencode auth` / console login); anything else skips. */
function desktopGoPlanKey(): string | undefined {  try {
    const auth = JSON.parse(readFileSync(join(homedir(), '.local/share/opencode/auth.json'), 'utf8'));
    const key = auth?.['opencode-go']?.key;
    return typeof key === 'string' && key.trim() ? key : undefined;
  } catch { return undefined; }
}

test('live: one real decide question on the Go plan (skipped without a desktop Go sign-in)', async (t) => {
  const key = desktopGoPlanKey();
  if (!key) { t.skip('no OpenCode Go plan key on this desktop'); return; }
  const { Accounts, memoryStore } = await import('../../accounts/src/index.ts');
  const saved = new Map<string, string>();
  const accounts = new Accounts({ store: () => memoryStore(), keyStore: () => ({
    get: async (id: string) => saved.get(id) ?? null,
    set: async (id: string, value: string) => { saved.set(id, value); },
    delete: async (id: string) => saved.delete(id),
    list: async () => [],
  }) });
  await accounts.add('Umer', 'opencode:plan_key:opencode-go', { key });
  const backend = opencodeGo({ model: 'muse-spark-1.3-contributor', account: accounts.opencodeGo('Umer') });
  const { urgent } = await decide({ text: 'The server room is on fire.' }, {
    urgent: { kind: 'yesno', question: 'Is this urgent?' },
  }, { privacy: 'may-leave', timeoutMs: 60_000, backends: [backend] });
  assert.equal(urgent.by, 'opencode-go');
  assert.equal(urgent.abstained, false);
  assert.equal(urgent.answer, true);
  assert.equal(urgent.confidenceSource, 'self-reported');
});
