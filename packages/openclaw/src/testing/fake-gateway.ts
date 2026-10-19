// The fake Gateway (5.11): an in-memory transport double driven by default handlers and scripts. Use it as
// `new OpenClawKit({ transport: fake.factory, spawnEngine: false, ... })` or drive `fake.transport.request`
// directly. No engine, no network, no account.
import { connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENGINE_VERSION, PROTOCOL_VERSION } from '../constants.ts';
import type { GatewayMethod, GatewayParams, GatewayTransport, Hello } from '../types.ts';
import type { KitOptions } from '../kit.ts';
import { toolCalls } from './model-stub.ts';
import { routes } from '../routes.ts';

type Handler = (params: Record<string, unknown>, bridgeSock: string) => unknown;

/** A scripted handler's params: the generated type when the pin publishes one, else the raw params object. */
export type FakeParams<M extends GatewayMethod> =
  unknown extends GatewayParams<M> ? Record<string, unknown> : GatewayParams<M>;

/** A scripted handler for one method, with that method's params typed. */
export type FakeHandler<M extends GatewayMethod = GatewayMethod> =
  (params: FakeParams<M>, bridgeSock: string) => unknown;

/** Pre-registered handlers for `fakeGateway(script)`, on top of the defaults (a same-name entry replaces one).
 * Only methods the pinned engine publishes are scriptable, exactly as `kit.call` and `kit.callDynamic` divide them. */
export type FakeScript = { [M in GatewayMethod]?: FakeHandler<M> };

// The device-code script from Crewhouse's openclaw-wizard.test.ts, ported: the step, then progress, then done.
const DEVICE_STEP = {
  id: 'step-device', type: 'note', executor: 'client',
  deviceCode: { code: 'CREW-2026', expiresInMinutes: 15 }, externalUrl: 'https://auth.openai.com/codex/device',
};
const PROGRESS_STEP = { id: 'step-wait', type: 'progress', message: 'Waiting for authorization', executor: 'gateway' };
// ChatGPT's browser route: the pin hands its unsigned authorize URL to the next step as `externalUrl`.
const BROWSER_STEP = {
  id: 'step-browser', type: 'note', executor: 'client', message: 'Open this URL in your LOCAL browser.',
  externalUrl: 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=fake-client&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fake-state',
};
// The pin's agents.create into an existing workspace rewrites IDENTITY.md's Name line (mergeIdentityMarkdownContent).
const IDENTITY_NAME = /^- \*\*Name:\*\*.*$/m;

const EVENTS = [
  'agent',
  'exec.approval.requested', 'exec.approval.resolved',
  'plugin.approval.requested', 'plugin.approval.resolved',
  'question.requested', 'question.resolved',
];

/** Window between a run's last event and its completion, so an abort issued on the text event still lands. */
const ABORT_WINDOW_MS = 25;
const BRIDGE_TIMEOUT_MS = 30_000;
// The plugin's accounts.js status thresholds: auth selection's refresh margin and auth-health's oauth warn window.
const EXPIRING_MS = 300_000;
const OAUTH_WARN_MS = 86_400_000;
// The plugin's account agent shape (D9) and agent id shape, as plugin/accounts.js tests them.
const ACCOUNT_AGENT = /--[0-9a-f]{6}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;

type Run = {
  runId: string;
  agentId: string;
  sessionKey: string;
  seq: number;
  provider: string;
  model: string;
  usage?: Record<string, number>;
  result?: Record<string, unknown>;
  waiters: ((result: Record<string, unknown>) => void)[];
  child?: { sock: string; relay: Promise<unknown> }; // an engine-created child: its events relayed in order to the bridge, as the plugin does
};

type WizardSession = { agentId: string; authChoice: string; answered: boolean; pulls: number };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    if (value === null) delete target[key]; // JSON merge-patch: null deletes, as the engine's config.patch does.
    else if (isPlainObject(current) && isPlainObject(value)) mergeInto(current, value);
    else target[key] = value;
  }
}

/** The one config invariant the engine itself keeps at runtime (5.6): memory search never leaves the free path. */
function enforceMemoryInvariants(config: Record<string, unknown>): void {
  const agents = (config.agents ?? {}) as { defaults?: Record<string, unknown>; entries?: Record<string, Record<string, unknown>> };
  // A node is whatever holds `.memory.search`: the config itself, an agent default, or one agent entry.
  const nodes: unknown[] = [config, agents.defaults, ...Object.values(agents.entries ?? {})];
  for (const node of nodes) {
    const search = ((node as Record<string, unknown> | undefined)?.memory as Record<string, unknown> | undefined)?.search;
    if (!isPlainObject(search)) continue;
    if ('provider' in search) search.provider = 'none';
    if ('fallback' in search) search.fallback = 'none';
  }
}

/**
 * The plugin's tool table, read from beside the kit's socket the way the plugin reads it. Absent (a bare socket with
 * no kit): every tool counts as the app's.
 */
function pluginTable(sock: string): { gateBuiltins?: boolean; tools: { name: string }[] } | undefined {
  try {
    return JSON.parse(readFileSync(join(dirname(sock), 'plugin', 'tools.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** One newline-framed request over the bridge socket, exactly what the plugin does (5.9). */
function bridgeRequest(path: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    let timer: NodeJS.Timeout;
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      if (buffer.length > 1_000_000) return fail(new Error('bridge reply too large'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { fail(error as Error); }
    });
    socket.once('connect', () => {
      timer = setTimeout(() => fail(new Error('bridge timed out')), BRIDGE_TIMEOUT_MS);
      socket.write(JSON.stringify(message) + '\n');
    });
  });
}

/** The fake's control surface: the transport to hand a kit, the calls it saw, and its triggers. */
export type FakeGateway = {
  factory: NonNullable<KitOptions['transport']>;
  calls: { method: string; params: unknown }[];
  emit(event: string, payload?: unknown): void;
  failNext(method: string, message: string): void;
  drop(why: string): void;
  handle(method: string, fn: FakeHandler): void;
  /** Usage windows a later `models.authStatus` read reports for the agent's provider (O14: the Auto input). */
  setUsage(agentId: string, provider: string, windows: { label: string; usedPercent?: number; resetAt?: number }[]): void;
  /** Profile fields every later wizard sign-in stores (O14 identity): `accountId: undefined` signs in with no account
   * id, so no `who`. With no call, or `signInAs()`, the account id is `fake-<agentId>`. */
  signInAs(fields?: { accountId?: string; email?: string; expires?: number }): void;
  /** A sealed profile already in an agent's store, as a sign-in of another provider leaves it; the agent's model points at it. */
  seedProfile(agentId: string, profileId: string, profile: { provider: string; type: string } & Record<string, unknown>): void;
  /** A late engine refresh racing a removal (O14 S8): writes one profile of `provider` onto `agentId` whole, as the
   * pin would under its store lock. With `order: false` it lands with no order entry; `expires` (default: valid)
   * may name an expired credential. */
  refresh(agentId: string, provider: string, o?: { order?: boolean; expires?: number }): void;
} & { transport: GatewayTransport };
export function fakeGateway(script?: FakeScript, o?: { rosterApplyMs?: number }): FakeGateway {
  const calls: { method: string; params: unknown }[] = [];
  const failures = new Map<string, string[]>();
  const handlers = new Map<string, Handler>();
  const agents = new Map<string, { id: string; workspace?: string; providers: string[] }>();
  const keys = new Map<string, { provider: string; key: string; sealed: boolean; model: string }>();
  // The account sealing method's own view: each agent's profile store, its per-provider order, and its model
  // primary (`provider/model@<profileId>`, as a real sign-in writes it), so `byokit.accounts` behaves like the pin.
  type FakeProfile = { provider: string; type: string; status?: string; accountId?: string; email?: string; expires?: number } & Record<string, unknown>;
  const profiles = new Map<string, Record<string, FakeProfile>>();
  const orders = new Map<string, Record<string, string[]>>();
  const models = new Map<string, string>();
  const wizards = new Map<string, WizardSession>();
  let signInFields: Partial<FakeProfile> | undefined;
  // Each workspace's files by name, as `agents.files.get/set` and the create-time IDENTITY.md rewrite see them.
  const workspaces = new Map<string, Map<string, string>>();
  const filesOf = (agentId: string): { workspace: string; files: Map<string, string> } => {
    const agent = agents.get(agentId);
    if (!agent) throw new Error(`unknown agent id "${agentId}"`);
    const workspace = agent.workspace ?? `workspace-${agentId}`;
    let files = workspaces.get(workspace);
    if (!files) { files = new Map(); workspaces.set(workspace, files); }
    return { workspace, files };
  };
  const fileAnswer = (agentId: string, name: string) => {
    const { workspace, files } = filesOf(agentId);
    const content = files.get(name);
    return { agentId, workspace, file: { name, path: join(workspace, name), missing: content === undefined,
      ...(content === undefined ? {} : { size: Buffer.byteLength(content), content }) } };
  };
  const runs = new Map<string, Run>();
  // Every session, as `<agentId>\n<key>`: what `sessions.resolve`, `sessions.list` and `chat.history` find. A run appends
  // its user, tool call, tool result and assistant rows, as the pin's transcript stores them; `updatedAt` moves on each.
  type Session = { sessionId: string; updatedAt: number; rows: Record<string, unknown>[]; provider?: string; model?: string };
  const sessions = new Map<string, Session>();
  const sessionOf = (agentId: string, key: string): Session => {
    let session = sessions.get(`${agentId}\n${key}`);
    if (!session) { session = { sessionId: randomUUID(), updatedAt: 0, rows: [] }; sessions.set(`${agentId}\n${key}`, session); }
    return session;
  };
  const append = (session: Session, row: Record<string, unknown>): void => {
    session.rows.push(row);
    session.updatedAt = Math.max(Date.now(), session.updatedAt + 1);
  };
  const activeOn = (agentId: string, key: string): boolean =>
    [...runs.values()].some((run) => !run.result && run.agentId === agentId && run.sessionKey === key);
  // The engine's own cached read of each provider's usage endpoint (O14): cold until a `models.authStatus`
  // answer has carried the provider once (no `usage` on that first answer), then whatever `setUsage` stored.
  // A pre-sign-in read names no provider, so it warms nothing: the journey's first room read stays cold.
  const usage = new Map<string, Map<string, { label: string; usedPercent?: number; resetAt?: number }[]>>();
  const warmed = new Set<string>();
  const configBox = { hash: 'hash-1', config: {} as Record<string, unknown> };
  let hashSeq = 1;

  const ensureAgent = (id: string, workspace?: string) => {
    let agent = agents.get(id);
    if (!agent) {
      agent = { id, workspace, providers: [] };
      agents.set(id, agent);
    } else if (workspace) agent.workspace = workspace;
    return agent;
  };
  const storeOf = (id: string): Record<string, FakeProfile> => {
    let store = profiles.get(id);
    if (!store) { store = {}; profiles.set(id, store); }
    return store;
  };
  const orderOf = (id: string): Record<string, string[]> => {
    let order = orders.get(id);
    if (!order) { order = {}; orders.set(id, order); }
    return order;
  };
  // As the plugin's accounts.js: `who` only exists for an OAuth profile that stores a provider account id.
  const whoOf = (credential: FakeProfile): string | undefined => credential.type === 'oauth' && typeof credential.accountId === 'string' && credential.accountId.length > 0
    ? createHash('sha256').update(`${credential.provider}\n${credential.accountId}`).digest('hex').slice(0, 16) : undefined;
  const hasSecret = (value: unknown, ref: unknown): boolean =>
    (typeof value === 'string' && value.length > 0) || (!!ref && typeof ref === 'object' && !Array.isArray(ref));
  // The plugin's token expiry state (credential-state.ts): missing, invalid, expired, or valid.
  const expiryState = (expires: number | undefined, now: number): string => {
    if (expires === undefined) return 'missing';
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0 || expires > 8.64e13) return 'invalid';
    return expires <= now ? 'expired' : 'valid';
  };
  // The plugin's profile status (auth-health.ts) from the credential alone: static, ok, expiring, expired or missing.
  const statusOf = (credential: FakeProfile, now: number): string => {
    if (credential.type === 'api_key') return hasSecret(credential.key, credential.keyRef) ? 'static' : 'missing';
    if (credential.type === 'token') {
      if (!hasSecret(credential.token, credential.tokenRef)) return 'missing';
      const state = expiryState(credential.expires, now);
      if (state === 'invalid') return 'missing';
      if (state === 'expired') return 'expired';
      if (credential.expires === undefined) return 'static';
      return credential.expires - now <= EXPIRING_MS ? 'expiring' : 'ok';
    }
    if (!hasSecret(credential.access, undefined) && !hasSecret(credential.refresh, undefined)) return 'missing';
    const expires = credential.expires;
    const state = expiryState(expires, now);
    if (state === 'invalid' || state === 'missing') return 'missing';
    if (state === 'expired') return 'expired';
    return (expires as number) - now <= OAUTH_WARN_MS ? 'expiring' : 'ok';
  };
  const entryPrimaryOf = (id: string): string | undefined => {
    const entries = (configBox.config.agents as { entries?: Record<string, unknown> } | undefined)?.entries as Record<string, Record<string, unknown>> | undefined;
    const entry = entries?.[id];
    const ref = entry?.model;
    if (typeof ref === 'string') return ref;
    if (isPlainObject(ref) && typeof ref.primary === 'string') return ref.primary as string;
    return undefined;
  };
  const primaryOfId = (id: string): string | undefined => entryPrimaryOf(id) ?? models.get(id);
  const setPrimaryOfId = (id: string, primary: string): void => {
    models.set(id, primary);
    const entries = (configBox.config.agents as { entries?: Record<string, unknown> } | undefined)?.entries as Record<string, Record<string, unknown>> | undefined;
    const entry = entries?.[id];
    if (entry && isPlainObject(entry)) {
      const current = entry.model;
      if (isPlainObject(current)) current.primary = primary;
      else entry.model = primary;
    }
  };
  const signInAgent = (id: string, provider: string, extra?: Partial<FakeProfile>) => {
    const agent = ensureAgent(id);
    if (!agent.providers.includes(provider)) agent.providers.push(provider);
    // The pin names the first profile of a provider `<provider>:default` and points the agent's model at it.
    storeOf(id)[`${provider}:default`] = { provider, type: 'oauth', status: 'ok', access: 'fake-access',
      refresh: 'fake-refresh', expires: Date.now() + 30 * 86_400_000, accountId: `fake-${id}`, ...extra };
    orderOf(id)[provider] = [`${provider}:default`];
    setPrimaryOfId(id, `${provider}/default@${provider}:default`);
  };

  // Every transport the factory made; events fan out to all of them, drop() closes all of them.
  const live = new Set<{
    open: boolean;
    events: Set<(e: { event: string; payload?: unknown }) => void>;
    closes: Set<(why: string) => void>;
  }>();
  let droppedWhy = '';

  const emit = (event: string, payload?: unknown) => {
    for (const transport of live) for (const fn of transport.events) fn({ event, payload });
  };

  const failNext = (method: string, message: string) => {
    const queue = failures.get(method);
    if (queue) queue.push(message);
    else failures.set(method, [message]);
  };

  const finish = (run: Run, result: Record<string, unknown>) => {
    if (run.result) return;
    run.result = result;
    for (const waiter of run.waiters.splice(0)) waiter(result);
  };

  const emitRun = (run: Run, stream: string, data: Record<string, unknown>) => {
    emit('agent', { runId: run.runId, seq: run.seq++, stream, ts: Date.now(), data });
    const child = run.child;
    if (child) child.relay = child.relay.then(() => bridgeRequest(child.sock, { kind: 'delegation-event',
      event: { runId: run.runId, sessionKey: run.sessionKey, stream, data } })).catch(() => {});
  };

  /**
   * A native `sessions_send` as the engine and plugin play it: the parent's dispatch is tracked before it goes, then the
   * exact target session runs as an engine-created child and the receipt names its run (delegated admission, 5.8).
   */
  const nativeSend = async (run: Run, parentRunId: string, input: Record<string, unknown>, callId: string, sock: string) => {
    const ids = { key: run.sessionKey, runId: parentRunId, callId };
    const prepared = await bridgeRequest(sock, { kind: 'delegation-prepare', ...ids, tool: 'sessions_send', input });
    if (prepared.allow === false) return { isError: true, output: String(prepared.reason) };
    const sessionKey = String(input.sessionKey);
    const agentId = /^agent:([^:]+):/.exec(sessionKey)?.[1];
    // Like the pin: a send reaches only a session that already exists (its agent's main excepted).
    const child = agentId && (sessions.has(`${agentId}\n${sessionKey}`) || sessionKey === `agent:${agentId}:main`)
      ? startRun({ agentId, sessionKey, message: input.message }, sock, true) : undefined;
    const details = child ? { status: 'accepted', runId: child.runId, sessionKey }
      : { status: 'error', error: `No session found: ${sessionKey}`, sessionKey };
    await bridgeRequest(sock, { kind: 'delegation-receipt', ...ids, result: { details } });
    return { isError: !child, output: JSON.stringify(details) };
  };

  /** The `agent` handler: the run's scripted turn, its `[tool NAME {json}]` calls through the real bridge. An
   * engine-created `child` names its own run on the bridge, as the plugin does with the engine's run id. */
  const startRun = (params: Record<string, unknown>, bridgeSock: string, child = false): { runId: string; status: 'accepted' } => {
    if (params.agentId != null && !agents.has(String(params.agentId))) throw new Error(`unknown agent: ${params.agentId}`);
    // Like the engine: the provider/model the run is called on, its own override or the member's (here openai).
    const run: Run = { runId: randomUUID(), agentId: String(params.agentId ?? 'main'), sessionKey: String(params.sessionKey ?? ''), seq: 0,
      provider: String(params.provider ?? 'openai'), model: String(params.model ?? 'gpt-5.1'), waiters: [] };
    runs.set(run.runId, run);
    if (child) { run.child = { sock: bridgeSock, relay: Promise.resolve() }; emitRun(run, 'lifecycle', { phase: 'start' }); }
    const session = sessionOf(run.agentId, run.sessionKey);
    session.provider = run.provider;
    session.model = run.model;
    const message = String(params.message ?? '');
    append(session, { role: 'user', content: [{ type: 'text', text: message }] });
    const text = `fake: ${message}`;
    setTimeout(() => {
      void (async () => {
        const table = bridgeSock ? pluginTable(bridgeSock) : undefined;
        let n = 0;
        for (const call of toolCalls(message)) {
          const toolCallId = `call-${++n}`;
          emitRun(run, 'tool', { phase: 'start', name: call.name, toolCallId, args: call.input });
          // As the plugin: an engine builtin is gated unless the app opted out, and an allowed one never calls back.
          const builtin = !!table && !table.tools.some((t) => t.name === call.name);
          let output = `${call.name} ran`;
          let isError = false;
          if (bridgeSock && !(builtin && table?.gateBuiltins === false)) {
            try {
              const owner = child ? { runId: run.runId } : {};
              const gate = await bridgeRequest(bridgeSock, { kind: 'gate', key: run.sessionKey, tool: call.name, input: call.input, ...owner });
              if (!gate.allow) {
                isError = true;
                output = String(gate.reason ?? 'blocked');
              } else if (builtin && call.name === 'sessions_send') {
                ({ isError, output } = await nativeSend(run, child ? run.runId : String(params.idempotencyKey ?? ''), call.input, toolCallId, bridgeSock));
              } else if (!builtin) {
                const done = await bridgeRequest(bridgeSock, { kind: 'call', key: run.sessionKey, permit: gate.permit, tool: call.name, input: call.input, ...owner });
                isError = done.ok !== true;
                output = String(done.ok === true ? done.text : done.reason);
              }
            } catch { /* no bridge or refused: the tool pair still plays, nothing is called */ }
          }
          // Completion rides `phase: 'result'` like the real engine (O11), not `'end'`, with its result.
          emitRun(run, 'tool', { phase: 'result', name: call.name, toolCallId, isError,
            result: { content: [{ type: 'text', text: output }] } });
          append(session, { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: call.name, arguments: call.input }] });
          append(session, { role: 'toolResult', toolCallId, toolName: call.name, isError, content: [{ type: 'text', text: output }] });
        }
        emitRun(run, 'assistant', { text });
        append(session, { role: 'assistant', content: [{ type: 'text', text }] });
        // The engine sums the run's usage (zero buckets omitted); the fake counts characters.
        run.usage = { input: message.length, output: text.length, total: message.length + text.length };
        setTimeout(() => {
          if (run.result || !child) return finish(run, { status: 'ok', terminalReply: { text } });
          // A child's lifecycle end, as the engine streams it: `hit the limit` plays the model's usage-limit error.
          const error = /hit the limit/i.test(message) ? 'You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.' : undefined;
          emitRun(run, 'lifecycle', error ? { phase: 'error', error } : { phase: 'end' });
          finish(run, error ? { status: 'error', error } : { status: 'ok', terminalReply: { text } });
        }, ABORT_WINDOW_MS);
      })();
    }, 0);
    return { runId: run.runId, status: 'accepted' };
  };

  /** The `agent` request's final frame (pin): the run's end with `result.meta.agentMeta`, once the run is over. */
  const finalOf = (runId: string): Promise<Record<string, unknown>> => new Promise((resolve) => {
    const run = runs.get(runId)!;
    const settle = (result: Record<string, unknown>) => {
      const ok = result.status === 'ok';
      resolve({ runId, status: ok ? 'ok' : 'error', summary: ok ? 'completed' : 'failed',
        ...(ok ? {} : { stopReason: result.stopReason }),
        result: { payloads: ok ? [{ text: (result.terminalReply as { text?: string } | undefined)?.text }] : [],
          meta: { agentMeta: { provider: run.provider, model: run.model, ...(run.usage ? { usage: run.usage } : {}) } } } });
    };
    if (run.result) settle(run.result);
    else run.waiters.push(settle);
  });

  const defaults: Record<string, Handler> = {
    health: () => ({ ok: true, plugins: { loaded: [] } }),
    'agents.list': () => ({
      defaultId: 'main', mainKey: 'main', scope: 'global',
      agents: [...agents.values()].map((agent) => ({ id: agent.id })),
    }),
    'agents.create': (p) => {
      const id = String(p.name);
      if (agents.has(id)) throw new Error(`agent "${id}" already exists`);
      const workspace = p.workspace ? String(p.workspace) : undefined;
      if (workspace) {
        const files = workspaces.get(workspace) ?? new Map<string, string>();
        workspaces.set(workspace, files);
        const identity = files.get('IDENTITY.md') ?? '# IDENTITY.md - Agent Identity\n\n';
        files.set('IDENTITY.md', IDENTITY_NAME.test(identity) ? identity.replace(IDENTITY_NAME, `- **Name:** ${id}`) : `${identity}- **Name:** ${id}\n`);
      }
      // With rosterApplyMs the fake mirrors the pinned engine: create answers before the roster hot-reload
      // makes the agent visible to agents.list (Crewhouse saw ~113 ms).
      if (o?.rosterApplyMs) setTimeout(() => ensureAgent(id, workspace), o.rosterApplyMs);
      else ensureAgent(id, workspace);
      return { ok: true, agentId: id, name: id, workspace: workspace ?? `workspace-${id}` };
    },
    // deleteFiles: false keeps the workspace, as the kit always asks; the agent's own store and model go.
    'agents.delete': (p) => {
      const id = String(p.agentId);
      if (!agents.has(id)) throw new Error(`agent "${id}" not found`);
      const drop = () => { agents.delete(id); profiles.delete(id); orders.delete(id); models.delete(id); };
      // With rosterApplyMs the fake mirrors the pinned engine: delete answers before the roster hot-reload
      // drops the agent from agents.list (the create side lags the same way).
      if (o?.rosterApplyMs) setTimeout(drop, o.rosterApplyMs);
      else drop();
      return { ok: true, agentId: id, removedBindings: 0 };
    },
    // model: null clears the agent's primary (config.patch cannot delete a key); a string sets it.
    'agents.update': (p) => {
      const id = String(p.agentId ?? '');
      if (!id) throw new Error('agents.update requires agentId');
      if ('model' in p) {
        const entries = (configBox.config.agents as { entries?: Record<string, Record<string, unknown>> } | undefined)?.entries;
        if (p.model === null) {
          models.delete(id);
          if (entries?.[id] && 'model' in entries[id]!) delete entries[id]!.model;
        } else if (typeof p.model === 'string') setPrimaryOfId(id, p.model);
        else throw new Error('agents.update model must be a string or null');
      }
      return { ok: true as const, agentId: id };
    },
    'agents.files.get': (p) => fileAnswer(String(p.agentId), String(p.name)),
    'agents.files.set': (p) => {
      filesOf(String(p.agentId)).files.set(String(p.name), String(p.content));
      return { ok: true, ...fileAnswer(String(p.agentId), String(p.name)) };
    },
    // One profile per signed-in provider, `<provider>:default`, as the pin lists an agent's own profiles.
    // Plus its cached usage once warm: cold on the first answer carrying the provider (no `usage`), then the
    // stored windows.
    'models.authStatus': (p) => {
      const id = String(p?.agentId ?? 'main');
      const store = storeOf(id);
      const now = Date.now();
      return {
        providers: (agents.get(id)?.providers ?? []).map((provider) => {
          const profileId = `${provider}:default`;
          const credential = store[profileId];
          const key = `${id}\n${provider}`;
          const cold = !warmed.has(key);
          warmed.add(key);
          const windows = cold ? undefined : usage.get(id)?.get(provider);
          return { provider,
            profiles: [{ profileId, type: credential?.type ?? 'oauth',
              status: credential ? statusOf(credential, now) : 'ok' }],
            ...(windows !== undefined ? { usage: { windows } } : {}) };
        }),
      };
    },
    // The runtime-allowed catalog for the agent's signed-in providers (O14): one available row each. A test
    // scripting exact availability scripts this method with `handle`.
    'models.list': (p) => {
      const id = String(p?.agentId ?? 'main');
      return {
        models: (agents.get(id)?.providers ?? []).map((provider) => ({ id: `${provider}/default`,
          name: 'Default', provider, available: true })),
      };
    },
    'models.authLogout': (p) => {
      const agent = agents.get(String(p?.agentId ?? 'main'));
      // The pin refuses a profileIds list naming a profile the agent does not hold.
      if (p.profileIds !== undefined && (!Array.isArray(p.profileIds) || !p.profileIds.length
        || p.profileIds.some((id: unknown) => id !== `${p.provider}:default` || !agent?.providers.includes(String(p.provider)))))
        throw new Error('profileIds contain unavailable auth profiles');
      if (agent) agent.providers = agent.providers.filter((provider) => provider !== p.provider);
      const store = profiles.get(String(p.agentId ?? 'main'));
      if (store) for (const profileId of Object.keys(store)) if (store[profileId].provider === p.provider) delete store[profileId];
      const order = orders.get(String(p.agentId ?? 'main'));
      if (order) delete order[String(p.provider)];
      const pin = models.get(String(p.agentId ?? 'main'));
      if (typeof pin === 'string' && pin.includes(`@${String(p.provider)}:`)) models.delete(String(p.agentId ?? 'main'));
      if (keys.get(String(p.agentId))?.provider === p.provider) keys.delete(String(p.agentId));
      return {};
    },
    'byokit.keys': (p) => {
      const id = `byokit-key-${p.member}`;
      if (p.action === 'prepare' || p.action === 'clear') {
        // As the shipped plugin: a clear of a lane that was never created has nothing to drop and reports absent.
        const lane = keys.has(id) || agents.has(id);
        keys.delete(id); ensureAgent(id).providers = [];
        return lane ? { ok: true } : { ok: false, absent: true };
      }
      const key = keys.get(id);
      if (!key) return { ok: false, absent: true };
      if (p.action === 'seal') { key.sealed = true; if (typeof p.model === 'string') key.model = p.model; return { ok: true }; }
      return key.sealed ? { ok: true, model: key.model } : { ok: false, absent: true };
    },
    // The provider's live catalog hook (5.6): every live model with its own api, once an agent holds the provider's key.
    'byokit.catalog': (p) => ([...keys.values()].some((key) => key.provider === p.provider) ? { ok: true, models: [
      { id: 'fake-key-model', name: 'Fake Key Model', api: 'openai-completions' },
      { id: 'fake-live-model', name: 'Fake Live Model', api: 'openai-responses' }] } : { ok: false, reason: 'no-key' }),
    // Account sealing (5.15): the same five actions, branches and refusals the shipped plugin method serves.
    'byokit.accounts': (p) => {
      const action = String(p.action ?? '');
      const entries = (configBox.config.agents as { entries?: Record<string, unknown> } | undefined)?.entries;
      const known = (id: string) => Boolean(id) && AGENT_ID.test(id) && ((Boolean(entries) && id in entries!) || agents.has(id));
      if (action === 'adopt') {
        const from = String(p.from), to = String(p.to), provider = String(p.provider);
        if (from === to || !known(from) || !known(to)) return { ok: false };
        if (typeof p.who !== 'string' || !p.who) return { ok: false };
        const fromOrder = orderOf(from), named = fromOrder[provider] ?? [];
        const fromId = named.length === 1 ? named[0] : undefined;
        const credential = fromId ? storeOf(from)[fromId] : undefined;
        if (!fromId || !credential || credential.provider !== provider || whoOf(credential) !== p.who) return { ok: false };
        const target = primaryOfId(to);
        if (typeof target !== 'string') return { ok: false };
        const toStore = storeOf(to), toOrder = orderOf(to);
        for (const [otherId, other] of Object.entries(toStore))
          if (ACCOUNT_AGENT.test(to) ? otherId !== fromId : other.provider === provider && otherId !== fromId) delete toStore[otherId];
        toStore[fromId] = credential;
        toOrder[provider] = [fromId];
        if (!ensureAgent(to).providers.includes(provider)) ensureAgent(to).providers.push(provider);
        delete storeOf(from)[fromId];
        if (fromOrder[provider]) { fromOrder[provider] = fromOrder[provider].filter((x) => x !== fromId); if (!fromOrder[provider].length) delete fromOrder[provider]; }
        if (!Object.values(storeOf(from)).some((c) => c.provider === provider))
          ensureAgent(from).providers = ensureAgent(from).providers.filter((x) => x !== provider);
        const cut = target.lastIndexOf('@');
        setPrimaryOfId(to, `${cut > 0 ? target.slice(0, cut) : target}@${fromId}`);
        return { ok: true };
      }
      const id = String(p.agentId ?? '');
      if (!known(id)) return { ok: false };
      const store = storeOf(id), order = orderOf(id);
      if (action === 'list')
        return { ok: true, profiles: Object.entries(store).map(([profileId, credential]) => ({ provider: credential.provider,
          profileId, type: credential.type, status: statusOf(credential, Date.now()), ...(whoOf(credential) ? { who: whoOf(credential) } : {}) })) };
      if (action === 'clear') {
        // Mirrors the plugin: a provider scope drops only that provider's profiles, order and lastGood.
        const scope = typeof p.provider === 'string' && p.provider ? String(p.provider) : undefined;
        if (!scope) { profiles.set(id, {}); orders.set(id, {}); }
        else {
          for (const [profileId, credential] of Object.entries(store)) if (credential.provider === scope) delete store[profileId];
          delete order[scope];
        }
        const cleared = agents.get(id);
        if (cleared) cleared.providers = scope ? cleared.providers.filter((x) => x !== scope) : [];
        return { ok: true }; }
      if (action === 'ready') {
        const provider = String(p.provider ?? '');
        const named = order[provider] ?? [];
        const credential = named.length === 1 ? store[named[0]] : undefined;
        if (!provider || !credential || credential.provider !== provider) return { ok: false };
        const status = statusOf(credential, Date.now());
        if (status === 'missing' || status === 'expired') return { ok: false };
        return { ok: true, type: credential.type, ...(typeof credential.expires === 'number' ? { expiresAt: credential.expires } : {}),
          ...(whoOf(credential) ? { who: whoOf(credential) } : {}) };
      }
      if (action === 'seal') {
        const primary = primaryOfId(id) ?? '';
        const at = primary.lastIndexOf('@');
        if (at < 1) return { ok: false };
        const profileId = primary.slice(at + 1);
        const credential = store[profileId];
        const account = ACCOUNT_AGENT.test(id);
        if (!credential || credential.provider !== p.provider
          || (!account && credential.type === 'api_key' && p.planKey !== true)) return { ok: false };
        for (const [otherId, other] of Object.entries(store))
          if (account ? otherId !== profileId : other.provider === p.provider && otherId !== profileId) delete store[otherId];
        // An account agent's whole order is replaced; a member's keeps its other providers, as plugin/accounts.js does.
        const provider = String(p.provider);
        if (account) orders.set(id, { [provider]: [profileId] });
        else order[provider] = [profileId];
        const sealedAgent = agents.get(id);
        if (sealedAgent) {
          if (account) sealedAgent.providers = [provider];
          else if (!sealedAgent.providers.includes(provider)) sealedAgent.providers.push(provider);
        }
        return { ok: true, ...(whoOf(credential) ? { who: whoOf(credential) } : {}) };
      }
      return { ok: false };
    },
    'openclaw.setup.activate': (p) => {
      if (p.kind !== 'api-key') throw new Error('only the API-key setup path is simulated');
      // The pin takes a pasted key only for a choice whose manifest allows one (`appGuidedSecret`).
      const route = routes().find((r) => r.choice === String(p.authChoice) && r.keyEntry);
      if (!route || route.upstream?.flow === 'absent')
        return { ok: false, status: 'unavailable', error: 'That key-based provider is not available on this Gateway.' };
      const model = `${route.provider}/fake-key-model`;
      keys.set(String(p.agentId), { provider: route.provider, key: String(p.apiKey), model, sealed: false });
      signInAgent(String(p.agentId), route.provider, { type: 'api_key', key: String(p.apiKey) });
      setPrimaryOfId(String(p.agentId), `${model}@${route.provider}:default`);
      return { ok: true, status: 'ok', modelRef: model };
    },
    'openclaw.setup.auth.start': (p) => {
      // The pin starts only an app-guided login; a key-entry choice is set up from its pasted key instead.
      const route = routes().find((r) => r.choice === String(p.authChoice ?? ''));
      if (!route || route.keyEntry || route.via === 'cli' || route.upstream?.flow === 'absent')
        throw new Error('That provider setup is not available on this Gateway.');
      // The pin's single setup admission: a second start while a session runs is refused.
      if (wizards.size) throw new Error('setup is already in progress');
      const sessionId = String(p.sessionId ?? `fake-${randomUUID()}`);
      wizards.set(sessionId, { agentId: String(p.agentId ?? 'main'), authChoice: String(p.authChoice ?? ''), answered: false, pulls: 0 });
      return { sessionId, done: false, status: 'running' };
    },
    'wizard.next': (p) => {
      const session = wizards.get(String(p.sessionId));
      if (!session) throw new Error(`unknown wizard session: ${p.sessionId}`);
      if (p.answer) {
        session.answered = true;
        return { done: false, step: PROGRESS_STEP };
      }
      if (!session.answered) return { done: false, step: session.authChoice === 'openai' ? BROWSER_STEP : DEVICE_STEP };
      if (session.pulls++ === 0) return { done: false, step: PROGRESS_STEP };
      wizards.delete(String(p.sessionId));
      signInAgent(session.agentId, 'openai', signInFields);
      return { done: true, status: 'done', modelActivation: { modelRef: 'openai/gpt-5.1' } };
    },
    'wizard.cancel': (p) => {
      wizards.delete(String(p.sessionId));
      return { status: 'cancelled' };
    },
    agent: (p, bridgeSock) => startRun(p, bridgeSock),
    'agent.wait': (p) =>
      new Promise((resolve, reject) => {
        const run = runs.get(String(p.runId));
        if (!run) return reject(new Error(`unknown run: ${p.runId}`));
        if (run.result) resolve(run.result);
        else run.waiters.push(resolve);
      }),
    'sessions.steer': () => ({}),
    // The pin: a key the agent holds answers its canonical key; a missing one errors unless `allowMissing`, which answers `{ ok: false }`.
    'sessions.resolve': (p) => {
      const key = String(p.key ?? ''), agentId = String(p.agentId ?? 'main');
      if (sessions.has(`${agentId}\n${key}`)) return { ok: true, key, agentId };
      if (p.allowMissing === true) return { ok: false };
      throw new Error(`No session found: ${key}`);
    },
    // The pin's rows for one agent (`search` matches a key substring), `hasActiveRun` while a run on it is live.
    'sessions.list': (p) => {
      const agentId = String(p.agentId ?? 'main'), search = String(p.search ?? '').toLowerCase();
      const rows = [...sessions].filter(([id]) => id.startsWith(`${agentId}\n`)).map(([id, s]) => ({ key: id.slice(agentId.length + 1), s }))
        .filter(({ key }) => key.toLowerCase().includes(search))
        .map(({ key, s }) => ({ key, sessionId: s.sessionId, updatedAt: s.updatedAt, hasActiveRun: activeOn(agentId, key),
          ...(s.provider ? { modelProvider: s.provider } : {}), ...(s.model ? { model: s.model } : {}) }));
      return { count: rows.length, sessions: rows };
    },
    // `fork` copies the parent's whole transcript, from any agent, into a new session id; refused while the parent runs.
    'sessions.create': (p) => {
      const agentId = String(p.agentId ?? 'main'), key = String(p.key ?? '');
      if (!agents.has(agentId)) throw new Error(`unknown agent id "${agentId}"`);
      const rows: Record<string, unknown>[] = [];
      let model: { provider?: string; model?: string } = {};
      if (p.fork === true) {
        const parentKey = String(p.parentSessionKey ?? '');
        const parentAgent = /^agent:([^:]+):/.exec(parentKey)?.[1] ?? 'main';
        const parent = sessions.get(`${parentAgent}\n${parentKey}`);
        if (!parent) throw new Error(`No session found: ${parentKey}`);
        if (activeOn(parentAgent, parentKey)) throw new Error(`Parent session ${parentKey} is still active; try again in a moment.`);
        rows.push(...structuredClone(parent.rows));
        model = { provider: parent.provider, model: parent.model };
      }
      const ref = typeof p.model === 'string' ? p.model : undefined;
      if (ref) model = ref.includes('/') ? { provider: ref.slice(0, ref.indexOf('/')), model: ref.slice(ref.indexOf('/') + 1) } : { ...model, model: ref };
      const session: Session = { sessionId: randomUUID(), updatedAt: Date.now(), rows, ...model };
      sessions.set(`${agentId}\n${key}`, session);
      return { ok: true, key, sessionId: session.sessionId, runStarted: false };
    },
    // A changed session (id or `updatedAt` other than expected) is refused before anything goes, as the pin does.
    'sessions.delete': (p) => {
      const agentId = String(p.agentId ?? 'main'), key = String(p.key ?? '');
      const session = sessions.get(`${agentId}\n${key}`);
      if ((p.expectedSessionId !== undefined && session?.sessionId !== p.expectedSessionId)
        || (p.expectedSessionUpdatedAt !== undefined && session?.updatedAt !== p.expectedSessionUpdatedAt))
        throw new Error(`Session ${key} changed before deletion. Retry.`);
      if (session && activeOn(agentId, key)) throw new Error(`Session ${key} is still active; try again.`);
      return { ok: true, key, deleted: sessions.delete(`${agentId}\n${key}`), archived: [] };
    },
    'chat.history': (p) => {
      const key = String(p.sessionKey ?? '');
      const agentId = String(p.agentId ?? /^agent:([^:]+):/.exec(key)?.[1] ?? 'main');
      const session = sessions.get(`${agentId}\n${key}`);
      return { sessionKey: key, ...(session ? { sessionId: session.sessionId } : {}), messages: structuredClone(session?.rows ?? []) };
    },
    'chat.abort': (p) => {
      for (const run of runs.values()) {
        if (run.result || run.sessionKey !== String(p.sessionKey ?? '')) continue;
        if (p.runId && run.runId !== String(p.runId)) continue;
        // Engine-shaped abort (O11): the receipt only says rpc-error; the run's lifecycle end carries aborted.
        emitRun(run, 'lifecycle', { phase: 'end', status: 'cancelled', aborted: true, stopReason: 'rpc' });
        finish(run, { status: 'error', stopReason: 'rpc' });
      }
      return {};
    },
    'config.get': () => ({ hash: configBox.hash, config: configBox.config }),
    'config.patch': (p) => {
      if (typeof p.raw !== 'string') throw new Error('config.patch requires raw');
      if (p.baseHash !== undefined && p.baseHash !== configBox.hash) throw new Error('stale config: baseHash does not match');
      const next = JSON.parse(p.raw) as Record<string, unknown>;
      // Like the real engine (O11) the merged config is validated, so entries added onto an already
      // explicit roster stay valid: a multi-agent roster without explicit ownership is invalid.
      const merged = JSON.parse(JSON.stringify(configBox.config)) as Record<string, unknown>;
      mergeInto(merged, next);
      const agents = merged.agents as Record<string, unknown> | undefined;
      const roster = Object.keys(agents?.entries as Record<string, unknown> ?? {});
      if ((roster.length > 1 || (roster.length === 1 && roster[0] !== 'main')) && agents?.ownership !== 'explicit')
        throw new Error('invalid config: agents.ownership: multi-agent rosters require agents.ownership="explicit"');
      mergeInto(configBox.config, next);
      enforceMemoryInvariants(configBox.config);
      configBox.hash = `hash-${++hashSeq}`;
      return { hash: configBox.hash };
    },
    // Real-shaped requested events: details nest under `request` (B1); question events stay flat upstream.
    'exec.approval.request': (p) => {
      const id = String(p.id ?? `exec-${randomUUID()}`);
      const now = Date.now();
      const plan = isPlainObject(p.systemRunPlan) ? p.systemRunPlan : {};
      emit('exec.approval.requested', {
        approvalKind: 'exec', id, createdAtMs: now, expiresAtMs: now + 180_000,
        request: {
          command: p.command,
          // Like the real engine, which normalizes the exec policy mode into request.ask (B8).
          ask: p.ask ?? 'on-miss',
          agentId: p.agentId ?? plan.agentId,
          sessionKey: p.sessionKey ?? plan.sessionKey,
        },
      });
      return { id };
    },
    'plugin.approval.request': (p) => {
      // Like the real engine: title and description are required, the engine mints the id.
      if (typeof p.title !== 'string' || typeof p.description !== 'string')
        throw new Error('plugin.approval.request requires title and description');
      const id = `plugin-${randomUUID()}`;
      const now = Date.now();
      emit('plugin.approval.requested', {
        approvalKind: 'plugin', id, createdAtMs: now, expiresAtMs: now + 180_000,
        request: { title: p.title, description: p.description, agentId: p.agentId, sessionKey: p.sessionKey },
      });
      return { id };
    },
    'exec.approval.resolve': (p) => {
      emit('exec.approval.resolved', { id: p.id, decision: p.decision });
      return {};
    },
    'exec.approval.list': () => ({ approvals: [] }),
    'plugin.approval.list': () => ({ approvals: [] }),
    'plugin.approval.resolve': (p) => {
      emit('plugin.approval.resolved', { id: p.id, decision: p.decision });
      return {};
    },
    'question.resolve': (p) => {
      emit('question.resolved', { id: p.id, answers: p.answers });
      return {};
    },
  };
  for (const [method, handler] of Object.entries(defaults)) handlers.set(method, handler);
  // A script handler is already per-method typed; the loose internal map only dispatches it.
  for (const [method, handler] of Object.entries(script ?? {})) handlers.set(method, handler as Handler);

  const dispatch = async (method: string, params: unknown, bridgeSock: string): Promise<unknown> => {
    calls.push({ method, params: method === 'openclaw.setup.activate' && isPlainObject(params)
      ? { ...params, ...(params.apiKey === undefined ? {} : { apiKey: '[redacted]' }) } : params });
    const queue = failures.get(method);
    if (queue?.length) throw new Error(queue.shift()!);
    const handler = handlers.get(method);
    if (!handler) throw new Error(`unknown method: ${method}`);
    return await handler(isPlainObject(params) ? params : {}, bridgeSock);
  };

  const hello = (): Hello => ({
    protocol: PROTOCOL_VERSION,
    server: { version: ENGINE_VERSION },
    // The methods the fake serves. The generated tables are type-only until O2 ships runtime names.
    methods: [...handlers.keys()].sort(),
    events: [...EVENTS],
  });

  const closedWhy = () => (droppedWhy ? `transport closed: ${droppedWhy}` : 'transport closed');

  const factory: NonNullable<KitOptions['transport']> = (ctx) => {
    const sock = ctx.bridgeSock;
    const entry = {
      open: true,
      events: new Set<(e: { event: string; payload?: unknown }) => void>(),
      closes: new Set<(why: string) => void>(),
    };
    live.add(entry);
    const transport: GatewayTransport = {
      start: async () => {
        if (!entry.open) throw new Error(closedWhy());
        return hello();
      },
      request: async (method, params, o) => {
        if (!entry.open) throw new Error(closedWhy());
        const reply = await dispatch(method, params, sock);
        // expectFinal: the interim accepted frame goes to onAccepted, the request settles with the final one.
        if (!o?.expectFinal || !isPlainObject(reply) || reply.status !== 'accepted' || typeof reply.runId !== 'string'
          || !runs.has(reply.runId)) return reply;
        o.onAccepted?.(reply);
        return finalOf(reply.runId);
      },
      onEvent: (fn) => (entry.events.add(fn), () => entry.events.delete(fn)),
      onClose: (fn) => (entry.closes.add(fn), () => entry.closes.delete(fn)),
      stop: async () => {
        entry.open = false;
        entry.events.clear();
        entry.closes.clear();
        live.delete(entry);
      },
    };
    return transport;
  };

  const drop = (why: string) => {
    droppedWhy = why;
    for (const entry of [...live]) {
      entry.open = false;
      const closes = [...entry.closes];
      entry.closes.clear();
      for (const fn of closes) fn(why);
      live.delete(entry);
    }
  };

  return {
    factory,
    calls,
    emit,
    failNext,
    drop,
    handle: (method, fn) => { handlers.set(method, fn); },
    setUsage: (agentId, provider, windows) => {
      let perAgent = usage.get(agentId);
      if (!perAgent) { perAgent = new Map(); usage.set(agentId, perAgent); }
      perAgent.set(provider, windows);
    },
    signInAs: (fields) => { signInFields = fields && { ...fields }; },
    seedProfile: (agentId, profileId, profile) => {
      ensureAgent(agentId);
      storeOf(agentId)[profileId] = profile;
      setPrimaryOfId(agentId, `${profile.provider}/default@${profileId}`);
    },
    refresh: (agentId, provider, o) => {
      const agent = ensureAgent(agentId);
      if (!agent.providers.includes(provider)) agent.providers.push(provider);
      const profileId = `${provider}:default`;
      storeOf(agentId)[profileId] = { provider, type: 'oauth', status: 'ok', access: 'fake-access',
        refresh: 'fake-refresh', expires: o?.expires ?? Date.now() + 30 * 86_400_000,
        accountId: `fake-refresh-${agentId}` };
      if (o?.order !== false) orderOf(agentId)[provider] = [profileId];
      else if (orderOf(agentId)[provider]) delete orderOf(agentId)[provider];
    },
    transport: factory({ port: 0, token: 'test', identityPath: '', bridgeSock: '' }),
  };
}
