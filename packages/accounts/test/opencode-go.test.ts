// The OpenCode Go plan-key route binds a member handle for consumers such as decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Accounts, memoryStore, ResponseError, KeyRouteError } from '../src/index.ts';
import { Accounts as Portable } from '../src/portable.ts';
import { withKeys } from '../src/keys.ts';
import { openCodeWorkspaces } from '../src/opencode-go.ts';
import { offered, planKey, provider, route, signInChoices } from '../src/catalogue.ts';
import { portable } from '../src/accounts.ts';
import type { Model, Context } from '../src/index.ts';

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

// The Go gateway's own rule on a real loopback socket: a request without the workspace header (or with
// another workspace's) is refused exactly as the real gateway refuses it; one that names it is answered.
function goGateway(): Promise<{ url: string; calls: { org?: string; bearer?: string; session?: string }[]; close(): Promise<void> }> {
  const calls: { org?: string; bearer?: string; session?: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const call = { org: req.headers['x-opencode-org-id'] as string | undefined, bearer: req.headers.authorization as string | undefined,
        session: req.headers['x-opencode-session'] as string | undefined };
      calls.push(call);
      if (call.org !== 'org_WORKING2') {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Workspace selection is required' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    calls, close: () => new Promise((done) => server.close(() => done())),
  })));
}

/** The accounts fetch the console probe uses: `orgs` answers the console's own listing, the loopback
 * gateway passes through to the real socket. Any other address is a test bug. */
function consoleFetch(orgs: unknown, status = 200) {
  const real = globalThis.fetch;
  return async (input: unknown, init?: unknown): Promise<Response> => {
    const url = String((input as { url?: string } | undefined)?.url ?? input);
    if (url === 'https://opencode.ai/console/api/orgs') return new Response(status === 200 ? JSON.stringify(orgs) : '', { status });
    if (url.startsWith('http://127.0.0.1:')) return real(input as Parameters<typeof real>[0], init as Parameters<typeof real>[1]);
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function goHarness(fetcher: ReturnType<typeof consoleFetch>) {
  const saved = new Map<string, string>();
  const kit = new Portable({ store: () => memoryStore(), keyStore: () => ({
    get: async (id: string) => saved.get(id) ?? null,
    set: async (id: string, value: string) => { saved.set(id, value); },
    delete: async (id: string) => saved.delete(id),
    list: async () => [],
  }), fetch: fetcher }, withKeys(portable));
  return kit;
}

const goModel = (url: string): Model<'openai-completions'> => ({ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'opencode-go',
  api: 'openai-completions', baseUrl: url, reasoning: false, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 128 });
const goContext: Context = { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] };

test('connect captures the Go workspace: one stored unasked, several returned typed, none keeps no header', async () => {
  const signal = new AbortController().signal;
  // One workspace: stored with the account, no pick.
  const one = goHarness(consoleFetch([{ id: 'org_WORKING2', name: 'Working2' }]));
  const added = await one.add('Umer', 'opencode:plan_key:opencode-go', { key: 'plan-key-canary' });
  assert.ok(added.id.startsWith('opencode:plan_key:opencode-go.'));
  assert.equal(added.workspaces, undefined);
  assert.equal(await one.opencodeGo('Umer').workspace!(signal), 'org_WORKING2');
  // Several: nothing saved, the pick comes back typed with its names, and the chosen one is stored.
  const many = goHarness(consoleFetch([{ id: 'org_A', name: 'Working' }, { id: 'org_WORKING2', name: 'Working2' }]));
  const pick = await many.add('Umer', 'opencode:plan_key:opencode-go', { key: 'plan-key-canary' });
  assert.deepEqual(pick.workspaces, [{ id: 'org_A', name: 'Working' }, { id: 'org_WORKING2', name: 'Working2' }]);
  assert.equal((await many.status('Umer', 'opencode')).state, 'signed_out', 'nothing saved while the pick is open');
  const chosen = await many.add('Umer', 'opencode:plan_key:opencode-go', { key: 'plan-key-canary', workspace: 'org_WORKING2' });
  assert.equal(chosen.workspaces, undefined);
  assert.equal(await many.opencodeGo('Umer').workspace!(signal), 'org_WORKING2');
  // A key the console refuses (a workspace-bound service key) connects with no workspace, unasked.
  const none = goHarness(consoleFetch([], 401));
  const bare = await none.add('Umer', 'opencode:plan_key:opencode-go', { key: 'sk-service-key' });
  assert.ok(bare.id.startsWith('opencode:plan_key:opencode-go.'));
  assert.equal(await none.opencodeGo('Umer').workspace!(signal), '');
  // The kit's own listing helper, for hosts that show the pick before connecting.
  assert.deepEqual(await openCodeWorkspaces('plan-key-canary', consoleFetch([{ id: 'org_A', name: 'Working' }])), [{ id: 'org_A', name: 'Working' }]);
  assert.deepEqual(await openCodeWorkspaces('sk-service-key', consoleFetch([], 403)), []);
});

test('every Go route call names the stored workspace, and the gateway refusal says to pick one', async () => {
  const gateway = await goGateway();
  try {
    const kit = goHarness(consoleFetch([{ id: 'org_WORKING2', name: 'Working2' }]));
    const { id } = await kit.add('Umer', 'opencode:plan_key:opencode-go', { key: 'plan-key-canary' });
    const answer = await kit.respondKey('Umer', { account: id, model: goModel(gateway.url), context: goContext });
    assert.equal(answer.stopReason, 'stop');
    assert.equal(gateway.calls.length, 1);
    assert.equal(gateway.calls[0].org, 'org_WORKING2', 'the stored workspace rode the call');
    assert.equal(gateway.calls[0].bearer, 'Bearer plan-key-canary');
    assert.ok(gateway.calls[0].session, 'the call names its conversation (the gateway 400s a stream without it)');

    // A key with no stored workspace is refused by the gateway with its own words; the typed error says to pick one.
    const bare = goHarness(consoleFetch([], 401));
    const bareId = (await bare.add('Umer', 'opencode:plan_key:opencode-go', { key: 'plan-key-canary' })).id;
    await assert.rejects(bare.respondKey('Umer', { account: bareId, model: goModel(gateway.url), context: goContext }),
      (e) => e instanceof KeyRouteError && e.code === 'needs_workspace' &&
        e.message === 'This account works with more than one workspace. Pick the one to use and connect it again.');
    assert.ok(gateway.calls.at(-1) && gateway.calls.at(-1)!.org === undefined, 'the refusal reached the gateway headerless');
  } finally { await gateway.close(); }
});
