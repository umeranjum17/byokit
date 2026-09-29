// The fake Gateway (5.11): an in-memory transport double driven by default handlers and scripts. Use it as
// `new OpenClawKit({ transport: fake.factory, spawnEngine: false, ... })` or drive `fake.transport.request`
// directly. No engine, no network, no account.
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENGINE_VERSION, PROTOCOL_VERSION } from '../constants.ts';
import type { GatewayTransport, Hello } from '../types.ts';
import type { KitOptions } from '../kit.ts';
import { toolCalls } from './model-stub.ts';

type Handler = (params: any, bridgeSock: string) => unknown;

/** Pre-registered handlers for `fakeGateway(script)`, on top of the defaults (a same-name entry replaces one). */
export type FakeScript = Record<string, Handler>;

// The device-code script from Crewhouse's openclaw-wizard.test.ts, ported: the step, then progress, then done.
const DEVICE_STEP = {
  id: 'step-device', type: 'note', executor: 'client',
  deviceCode: { code: 'CREW-2026', expiresInMinutes: 15 }, externalUrl: 'https://auth.openai.com/codex/device',
};
const PROGRESS_STEP = { id: 'step-wait', type: 'progress', message: 'Waiting for authorization', executor: 'gateway' };

const EVENTS = [
  'agent',
  'exec.approval.requested', 'exec.approval.resolved',
  'plugin.approval.requested', 'plugin.approval.resolved',
  'question.requested', 'question.resolved',
];

/** Window between a run's last event and its completion, so an abort issued on the text event still lands. */
const ABORT_WINDOW_MS = 25;
const BRIDGE_TIMEOUT_MS = 30_000;

type Run = {
  runId: string;
  sessionKey: string;
  seq: number;
  result?: Record<string, unknown>;
  waiters: ((result: Record<string, unknown>) => void)[];
};

type WizardSession = { agentId: string; answered: boolean; pulls: number };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) mergeInto(current, value);
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

export function fakeGateway(script?: FakeScript): {
  factory: NonNullable<KitOptions['transport']>;
  calls: { method: string; params: unknown }[];
  emit(event: string, payload?: unknown): void;
  failNext(method: string, message: string): void;
  drop(why: string): void;
  handle(method: string, fn: Handler): void;
} & { transport: GatewayTransport } {
  const calls: { method: string; params: unknown }[] = [];
  const failures = new Map<string, string[]>();
  const handlers = new Map<string, Handler>();
  const agents = new Map<string, { id: string; workspace?: string; providers: string[] }>();
  const wizards = new Map<string, WizardSession>();
  const runs = new Map<string, Run>();
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
  const signInAgent = (id: string, provider: string) => {
    const agent = ensureAgent(id);
    if (!agent.providers.includes(provider)) agent.providers.push(provider);
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

  const emitRun = (run: Run, stream: string, data: Record<string, unknown>) =>
    emit('agent', { runId: run.runId, seq: run.seq++, stream, ts: Date.now(), data });

  /** The `agent` handler: the run's scripted turn, its `[tool NAME {json}]` calls through the real bridge. */
  const startRun = (params: any, bridgeSock: string): { runId: string } => {
    if (params.agentId != null && !agents.has(String(params.agentId))) throw new Error(`unknown agent: ${params.agentId}`);
    const run: Run = { runId: randomUUID(), sessionKey: String(params.sessionKey ?? ''), seq: 0, waiters: [] };
    runs.set(run.runId, run);
    const message = String(params.message ?? '');
    const text = `fake: ${message}`;
    setTimeout(() => {
      void (async () => {
        const table = bridgeSock ? pluginTable(bridgeSock) : undefined;
        for (const call of toolCalls(message)) {
          emitRun(run, 'tool', { name: call.name, phase: 'start' });
          // As the plugin: an engine builtin is gated unless the app opted out, and an allowed one never calls back.
          const builtin = !!table && !table.tools.some((t) => t.name === call.name);
          if (bridgeSock && !(builtin && table?.gateBuiltins === false)) {
            try {
              const gate = await bridgeRequest(bridgeSock, { kind: 'gate', key: run.sessionKey, tool: call.name, input: call.input });
              if (gate.allow && !builtin)
                await bridgeRequest(bridgeSock, { kind: 'call', key: run.sessionKey, permit: gate.permit, tool: call.name, input: call.input });
            } catch { /* no bridge or refused: the tool pair still plays, nothing is called */ }
          }
          // Completion rides `phase: 'result'` like the real engine (O11), not `'end'`.
          emitRun(run, 'tool', { name: call.name, phase: 'result' });
        }
        emitRun(run, 'assistant', { text });
        setTimeout(() => finish(run, { status: 'ok', terminalReply: { text } }), ABORT_WINDOW_MS);
      })();
    }, 0);
    return { runId: run.runId };
  };

  const defaults: Record<string, Handler> = {
    health: () => ({ ok: true, plugins: { loaded: [] } }),
    'agents.list': () => ({
      defaultId: 'main', mainKey: 'main', scope: 'global',
      agents: [...agents.values()].map((agent) => ({ id: agent.id })),
    }),
    'agents.create': (p) => {
      ensureAgent(String(p.name), p.workspace ? String(p.workspace) : undefined);
      return { id: String(p.name) };
    },
    'models.authStatus': (p) => ({
      providers: (agents.get(String(p?.agentId ?? 'main'))?.providers ?? []).map((provider) => ({ provider })),
    }),
    'models.authLogout': (p) => {
      const agent = agents.get(String(p?.agentId ?? 'main'));
      if (agent) agent.providers = agent.providers.filter((provider) => provider !== p.provider);
      return {};
    },
    'openclaw.setup.auth.start': (p) => {
      const sessionId = String(p.sessionId ?? `fake-${randomUUID()}`);
      wizards.set(sessionId, { agentId: String(p.agentId ?? 'main'), answered: false, pulls: 0 });
      return { sessionId, done: false, status: 'running' };
    },
    'wizard.next': (p) => {
      const session = wizards.get(String(p.sessionId));
      if (!session) throw new Error(`unknown wizard session: ${p.sessionId}`);
      if (p.answer) {
        session.answered = true;
        return { done: false, step: PROGRESS_STEP };
      }
      if (!session.answered) return { done: false, step: DEVICE_STEP };
      if (session.pulls++ === 0) return { done: false, step: PROGRESS_STEP };
      wizards.delete(String(p.sessionId));
      signInAgent(session.agentId, 'openai');
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
      emit('exec.approval.requested', {
        approvalKind: 'exec', id, createdAtMs: now, expiresAtMs: now + 180_000,
        request: {
          command: p.command,
          // Like the real engine, which normalizes the exec policy mode into request.ask (B8).
          ask: p.ask ?? 'on-miss',
          agentId: p.agentId ?? p.systemRunPlan?.agentId,
          sessionKey: p.sessionKey ?? p.systemRunPlan?.sessionKey,
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
  for (const [method, handler] of Object.entries(script ?? {})) handlers.set(method, handler);

  const dispatch = async (method: string, params: unknown, bridgeSock: string): Promise<unknown> => {
    calls.push({ method, params });
    const queue = failures.get(method);
    if (queue?.length) throw new Error(queue.shift()!);
    const handler = handlers.get(method);
    if (!handler) throw new Error(`unknown method: ${method}`);
    return await handler(params ?? {}, bridgeSock);
  };

  const hello = (): Hello => ({
    protocol: PROTOCOL_VERSION,
    server: { version: ENGINE_VERSION },
    // The methods the fake serves. The generated tables are type-only until O2 ships runtime names; O11's
    // generated.test.ts cross-checks the real engine's hello against the committed tables.
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
      request: async (method, params) => {
        if (!entry.open) throw new Error(closedWhy());
        return dispatch(method, params, sock);
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
    transport: factory({ port: 0, token: 'test', identityPath: '', bridgeSock: '' }),
  };
}
