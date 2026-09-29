// The fake Herdr control plane (docs/runtime-kits.md 6.8): NDJSON JSON-RPC on a unix socket, one
// request per connection — the server closes after answering; only `events.subscribe` is held open.
// Ported from muxr `perf/fake-herdr/server.mjs` with the UI plugins, title churn, graphics and perf
// byte rates removed.
import { mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { HERDR_PROTOCOL, HERDR_VERSION } from '../../constants.ts';
import { writeBinShim } from './bin.ts';
import { agentRecord, createWorld, paneScroll, relayoutTab,
  type FakeAgent, type FakePane, type FakePluginSeed, type FakeWorld, type FakeWorkspace } from './world.ts';

const PROMPT_SETTLE_MS = 50;   // 6.8: the agent settles 50 ms after a prompt
const WAIT_POLL_MS = 5;

// The subscription kinds that need a `pane_id` filter and ride their own socket each
// (src/generated/events.ts HerdrEventFilters), in the live underscore wire spelling —
// subscriptions arrive in either spelling and are normalized with wireName below. A batch
// holding one rejects the whole batch when the filter is missing or when it shares the
// batch with another kind.
const FILTERED = new Set(['pane_agent_status_changed', 'pane_output_matched', 'pane_scroll_changed']);

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export type FakeHerdrOptions = {
  dir: string;                        // test-owned scratch dir; the fake writes nothing outside it
  socketPath?: string;                // default <dir>/herdr.sock
  world?: {
    cwd?: string;
    kinds?: readonly string[];        // agent kinds for server.agent_manifests; the first owns w1:p2
    seed?: number;                    // deterministic id offset: the first created workspace is
                                      // w(2+seed), the first split pane is w1:p(3+seed), revisions start at seed
    plugins?: readonly FakePluginSeed[];   // entries `plugin.list` answers with (default none)
  };
  agentStartFaults?: AgentStartFault[]; // queued `agent.start` failures, consumed FIFO (K7)
  onStop?: () => void;                // called after shutdown completes (the `server` bin verb exits on it)
};

export type AgentStartFault = { code: string; message?: string };

export type FakeHerdr = {
  socketPath: string;
  bin: string;
  // The documented test handle to the fake's state. This is the LIVE world the server answers
  // from — not a frozen clone — so a test reads `fake.world` for its behavioural assertions
  // (pane ids, agent names, revisions, scroll offsets, plugin entries) and may mutate it
  // directly (e.g. seed an agent name) before driving the kit over the socket.
  world: FakeWorld;
  agentStartFaults: AgentStartFault[]; // live queue: push faults, each `agent.start` shifts one (K7)
  emit(event: { type: string } & Record<string, unknown>): void;
  setStatus(paneId: string, status: string): void;
  // Panes with a held filtered subscription (`pane.agent_status_changed`, `pane.output_matched`
  // or `pane.scroll_changed`): the full watched set, or whether one pane is watched.
  watching(): string[];
  watching(paneId: string): boolean;
  snapshotCount(): number;            // `session.snapshot` calls answered so far
  holdSnapshot(): () => void;         // hold the next snapshot answer(s) until the release runs
  failNextSnapshot(code?: string, message?: string): void;   // the next snapshot answer errors once
  holdAck(): () => void;              // hold the next subscribe ack(s) until the release runs
  failNextAck(code?: string, message?: string): void;        // the next subscribe is rejected once
  subscriptionCount(): number;        // distinct sockets holding a subscription (batch + filtered)
  stop(): Promise<void>;
};

type Params = Record<string, unknown>;
type LiveWorld = FakeWorld & { nextPane: number; nextWorkspace: number; nextRevision: number; zoomed: boolean };

export async function startFakeHerdr(options: FakeHerdrOptions): Promise<FakeHerdr> {
  const dir = options.dir;
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('fake-herdr: dir is required');
  mkdirSync(dir, { recursive: true });
  const socketPath = options.socketPath ?? join(dir, 'herdr.sock');
  const cwd = join(dir, 'project');
  mkdirSync(cwd, { recursive: true });
  const kinds = [...(options.world?.kinds ?? ['pi'])];
  const seed = options.world?.seed ?? 0;

  const live: LiveWorld = Object.assign(
    createWorld({ cwd, kinds, plugins: options.world?.plugins }),
    {
      nextPane: 3 + seed,
      nextWorkspace: 2 + seed,
      nextRevision: seed,
      zoomed: false,
    },
  );
  // Queued `agent.start` failures (K7): each start shifts one and fails with its code, so a test
  // scripts busy-then-ok or a permanent failure. The array is live on the handle — push more faults
  // any time before (or during) the starts under test.
  const agentStartFaults: AgentStartFault[] = [...(options.agentStartFaults ?? [])];

  const sockets = new Set<Socket>();
  const eventSubs = new Set<{ socket: Socket; kinds: Set<string> }>();
  const filteredSubs = new Set<{ socket: Socket; type: string; paneId: string }>();
  const timers: NodeJS.Timeout[] = [];
  let stopping = false;
  let snapshots = 0;
  let snapshotGates: { promise: Promise<void>; release: () => void }[] = [];
  let nextSnapshotFailure: { code: string; message: string } | undefined;
  let ackGates: { promise: Promise<void>; release: () => void }[] = [];
  let nextAckFailure: { code: string; message: string } | undefined;

  const gate = (list: { promise: Promise<void>; release: () => void }[]): (() => void) => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    const entry = { promise, release: () => {} };
    entry.release = () => {
      release();
      list.splice(list.indexOf(entry), 1);
    };
    list.push(entry);
    return entry.release;
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let answered = false;            // one request per socket; only events.subscribe stays open
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        if (answered) { socket.destroy(); return; }   // a second request on one socket is not Herdr
        answered = true;
        void handleLine(socket, line);
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      for (const sub of eventSubs) if (sub.socket === socket) eventSubs.delete(sub);
      for (const sub of filteredSubs) if (sub.socket === socket) filteredSubs.delete(sub);
    });
    socket.on('error', () => {});
  });

  unlinkQuiet(socketPath);
  await listen(server, socketPath);
  const bin = writeBinShim({ dir, socketPath });

  const methods: Record<string, (params: Params) => unknown | Promise<unknown>> = {
    ping: () => ({ protocol: HERDR_PROTOCOL, version: HERDR_VERSION }),

    'session.snapshot': async () => {
      snapshots += 1;
      for (const held of snapshotGates) await held.promise;
      if (stopping) throw fail('error', 'the fake is stopping');
      const failure = nextSnapshotFailure;
      nextSnapshotFailure = undefined;
      if (failure !== undefined) throw fail(failure.code, failure.message);
      return { type: 'session_snapshot', snapshot: snapshotOf() };
    },

    'workspace.list': () => ({ workspaces: live.workspaces.map((w) => workspaceView(w)) }),
    'workspace.get': (p) => {
      const workspace = live.workspaces.find((row) => row.workspace_id === p.workspace_id);
      if (workspace === undefined) throw fail('workspace_not_found', 'workspace not found');
      return { workspace: workspaceView(workspace) };
    },
    'workspace.create': (p) => {
      const workspace = addWorkspace(label(p) ?? live.cwd);
      // A new workspace comes with its root tab and root pane (6.4: the kit reads
      // result.root_pane.pane_id from workspace.create and tab.create alike).
      const tab = addTab(workspace.workspace_id, 'main');
      const pane = addPane(tab.tab_id, workspace.workspace_id, workspace.label);
      const env = envOf(p);
      if (env !== undefined) pane.env = env;
      if (p.focus === true) focusWorkspace(workspace.workspace_id);
      emitEvent('workspace.created', { workspace: workspaceView(workspace) });
      return { workspace: workspaceView(workspace), root_pane: { pane_id: pane.pane_id } };
    },
    'workspace.close': (p) => {
      if (!live.workspaces.some((row) => row.workspace_id === p.workspace_id)) {
        throw fail('workspace_not_found', 'workspace not found');
      }
      const tabs = live.tabs.filter((tab) => tab.workspace_id === p.workspace_id).map((tab) => tab.tab_id);
      for (const tabId of tabs) removeTab(tabId);
      live.workspaces = live.workspaces.filter((row) => row.workspace_id !== p.workspace_id);
      emitEvent('workspace.closed', { workspace_id: p.workspace_id });
      return {};
    },
    'workspace.focus': (p) => {
      if (!live.workspaces.some((row) => row.workspace_id === p.workspace_id)) {
        throw fail('workspace_not_found', 'workspace not found');
      }
      focusWorkspace(p.workspace_id as string);
      return {};
    },
    'workspace.report_metadata': (p) => {
      const workspace = live.workspaces.find((row) => row.workspace_id === p.workspace_id);
      if (workspace === undefined) throw fail('workspace_not_found', 'workspace not found');
      if (p.tokens !== undefined && typeof p.tokens === 'object') {
        workspace.tokens = { ...workspace.tokens, ...(p.tokens as Params as Record<string, string>) };
      }
      return {};
    },
    'workspace.rename': (p) => {
      const workspace = live.workspaces.find((row) => row.workspace_id === p.workspace_id);
      if (workspace === undefined) throw fail('workspace_not_found', 'workspace not found');
      if (typeof p.label !== 'string' || p.label.length === 0) throw fail('invalid_label', 'a label is required');
      workspace.label = p.label;
      emitEvent('workspace.renamed', { workspace_id: workspace.workspace_id, label: workspace.label });
      return { type: 'workspace_info', workspace: workspaceView(workspace) };
    },

    'worktree.create': (p) => {
      const checkout = typeof p.cwd === 'string' && p.cwd.length > 0 ? p.cwd : join(live.cwd, `wt-${live.nextWorkspace}`);
      const workspace = addWorkspace(checkout);
      workspace.worktree = {
        repo_key: 'fake-herdr',
        repo_name: 'fake-herdr',
        repo_root: live.cwd,
        checkout_path: checkout,
        is_linked_worktree: true,
      };
      // Like the pinned server, the linked checkout opens with its root tab and root pane in the
      // checkout, carrying the placement env; the kit reads result.root_pane.pane_id (K7).
      const tab = addTab(workspace.workspace_id, 'main');
      const pane = addPane(tab.tab_id, workspace.workspace_id, checkout);
      const env = envOf(p);
      if (env !== undefined) pane.env = env;
      if (p.focus === true) focusWorkspace(workspace.workspace_id);
      emitEvent('workspace.created', { workspace: workspaceView(workspace) });
      return { workspace: { ...workspaceView(workspace), worktree: workspace.worktree },
        tab: tabView(tab), root_pane: { pane_id: pane.pane_id } };
    },

    'tab.list': (p) => ({ tabs: live.tabs.filter((tab) => tab.workspace_id === p.workspace_id) }),
    'tab.get': (p) => {
      const tab = live.tabs.find((row) => row.tab_id === p.tab_id);
      if (tab === undefined) throw fail('tab_not_found', 'tab not found');
      return { tab: tabView(tab) };
    },
    'tab.create': (p) => {
      const workspace = live.workspaces.find((row) => row.workspace_id === p.workspace_id);
      if (workspace === undefined) throw fail('workspace_not_found', 'workspace not found');
      const tab = addTab(workspace.workspace_id, label(p) ?? workspace.label ?? live.cwd);
      const pane = addPane(tab.tab_id, workspace.workspace_id, (p.cwd as string | undefined) ?? workspace.label ?? live.cwd);
      const env = envOf(p);
      if (env !== undefined) pane.env = env;
      if (p.focus === true) focusPane(pane.pane_id);
      emitEvent('tab.created', { tab: tabView(tab) });
      return { tab: tabView(tab), root_pane: { pane_id: pane.pane_id } };
    },
    'tab.close': (p) => {
      const tabWorkspace = live.tabs.find((row) => row.tab_id === p.tab_id)?.workspace_id;
      if (tabWorkspace === undefined) throw fail('tab_not_found', 'tab not found');
      removeTab(p.tab_id as string);
      emitEvent('tab.closed', { tab_id: p.tab_id, workspace_id: tabWorkspace });
      return {};
    },
    'tab.focus': (p) => {
      const tab = live.tabs.find((row) => row.tab_id === p.tab_id);
      if (tab === undefined) throw fail('tab_not_found', 'tab not found');
      const pane = live.panes.find((row) => row.tab_id === tab.tab_id);
      if (pane !== undefined) focusPane(pane.pane_id);
      return {};
    },
    'tab.rename': (p) => {
      const tab = live.tabs.find((row) => row.tab_id === p.tab_id);
      if (tab === undefined) throw fail('tab_not_found', 'tab not found');
      if (typeof p.label !== 'string' || p.label.length === 0) throw fail('invalid_label', 'a label is required');
      tab.label = p.label;
      emitEvent('tab.renamed', { tab_id: tab.tab_id, workspace_id: tab.workspace_id, label: tab.label });
      return { type: 'tab_info', tab: tabView(tab) };
    },

    'pane.get': (p) => ({ pane: paneView(paneOf(p.pane_id)) }),
    'pane.close': (p) => {
      const pane = paneOf(p.pane_id);
      live.panes = live.panes.filter((row) => row.pane_id !== pane.pane_id);
      live.agents = live.agents.filter((row) => row.pane_id !== pane.pane_id);
      relayoutTab(live, pane.tab_id);
      emitEvent('pane.closed', { pane_id: pane.pane_id, workspace_id: pane.workspace_id });
      return {};
    },
    'pane.focus': (p) => {
      focusPane(paneOf(p.pane_id).pane_id);
      return {};
    },
    'pane.split': (p) => {
      const target = paneOf(p.target_pane_id);
      const pane = addPane(target.tab_id, target.workspace_id, target.cwd);
      const env = envOf(p);
      if (env !== undefined) pane.env = env;
      if (p.focus === true) focusPane(pane.pane_id);
      emitEvent('pane.created', { pane: paneView(pane) });
      return { pane: { pane_id: pane.pane_id } };
    },
    'pane.read': (p) => {
      const pane = paneOf(p.pane_id);
      const body = paneText(pane, p.source);
      const lines = typeof p.lines === 'number' ? body.split('\n').slice(0, p.lines).join('\n') : body;
      return { read: { text: lines, truncated: false } };
    },
    'pane.send_keys': (p) => {
      const pane = paneOf(p.pane_id);
      const keys = Array.isArray(p.keys) ? p.keys as string[] : [];
      pane.text.push(keys.join(''));
      return { pane_id: pane.pane_id, keys };
    },
    'pane.report_metadata': (p) => {
      const pane = live.panes.find((row) => row.pane_id === p.pane_id);
      if (pane !== undefined && p.tokens !== undefined && typeof p.tokens === 'object') {
        pane.tokens = { ...pane.tokens, ...(p.tokens as Params) };
      }
      return {};
    },
    'pane.rename': (p) => {
      const pane = paneOf(p.pane_id);
      // A null label clears back to the shell default; a rename never moves the revision,
      // so an open approval question stays answerable at its recorded revision.
      if (p.label !== undefined && p.label !== null) {
        if (typeof p.label !== 'string' || p.label.length === 0) throw fail('invalid_label', 'a label is required');
        pane.label = p.label;
      } else if (p.label === null) {
        pane.label = 'zsh';
      }
      return { type: 'pane_info', pane: paneView(pane) };
    },
    'pane.scroll': (p) => {
      const pane = paneOf(p.pane_id);
      const offset = typeof p.offset_from_bottom === 'number' && Number.isSafeInteger(p.offset_from_bottom)
        ? Math.max(0, Math.min(pane.scroll.max_offset_from_bottom, p.offset_from_bottom))
        : pane.scroll.offset_from_bottom;
      pane.scroll = { ...pane.scroll, offset_from_bottom: offset };
      emitEvent('pane.scroll_changed', {
        pane_id: pane.pane_id, workspace_id: pane.workspace_id, scroll: { ...pane.scroll },
      });
      return { type: 'pane_info', pane: paneView(pane) };
    },
    'pane.zoom': (p) => {
      paneOf(p.pane_id);
      const mode = p.mode ?? 'toggle';
      const next = mode === 'on' ? true : mode === 'off' ? false : !live.zoomed;
      const changed = next !== live.zoomed;
      live.zoomed = next;
      return { zoom: { changed, zoomed: live.zoomed } };
    },
    'pane.layout': (p) => ({ layout: tabLayout(paneOf(p.pane_id).tab_id) }),

    'agent.start': (p) => {
      const fault = agentStartFaults.shift();
      if (fault !== undefined) throw fail(fault.code, fault.message ?? fault.code);
      const pane = paneOf(p.pane_id);
      const kind = typeof p.kind === 'string' && p.kind.length > 0 ? p.kind : 'pi';
      const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : kind;
      pane.agent_status = 'idle';
      pane.label = name;
      pane.terminal_title = `${kind} · ${name}`;
      pane.terminal_title_stripped = pane.terminal_title;
      const agent = agentRecord({
        paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id, cwd: pane.cwd,
        name, kind, revision: ++live.nextRevision, focused: pane.focused,
      });
      const index = live.agents.findIndex((row) => row.pane_id === pane.pane_id);
      if (index === -1) live.agents.push(agent);
      else live.agents[index] = agent;
      pane.revision = agent.revision;
      emitEvent('pane.agent_detected', { pane_id: pane.pane_id, workspace_id: pane.workspace_id, agent: kind });
      // The boot-window reply: the 0.8 shape muxr reads (`agent`) plus the pinned 0.9.1 envelope
      // (`type`/`argv`), so a launch flow keeps its assertions against either shape.
      return { type: 'agent_started', agent, argv: Array.isArray(p.args) ? p.args : [] };
    },
    'agent.rename': (p) => {
      const agent = live.agents.find((row) => row.pane_id === p.target);
      if (agent === undefined) throw fail('agent_not_found', 'agent not found');
      const name = p.name;
      if (name !== undefined && name !== null) {
        if (typeof name !== 'string' || !AGENT_NAME.test(name)) {
          throw fail('invalid_agent_name', 'an agent name matches /^[a-z][a-z0-9_-]{0,31}$/');
        }
        if (live.agents.some((row) => row.pane_id !== agent.pane_id && row.name === name)) {
          throw fail('agent_name_taken', `another agent is already named ${name}`);
        }
        const pane = live.panes.find((row) => row.pane_id === agent.pane_id);
        if (pane !== undefined && pane.label === agent.name) pane.label = name;
        agent.name = name;
      }
      return { type: 'agent_info', agent: { ...agent } };
    },
    'agent.prompt': (p) => {
      const pane = paneOf(p.target);
      const agent = agentOf(pane);
      transition(pane, 'working');
      const text = typeof p.text === 'string' ? p.text : '';
      const revision = agent !== undefined ? agent.revision : live.nextRevision;
      timers.push(setTimeout(() => {
        if (stopping) return;
        if (text === 'ask permission') {
          if (agent !== undefined) agent.detection = 'Allow this? (y/n)';
          pane.text.push('Allow this? (y/n)');
          transition(pane, 'blocked');
        } else {
          pane.text.push(`fake ${agent?.agent ?? 'pi'}: ${text}`);
          transition(pane, 'idle');
        }
      }, PROMPT_SETTLE_MS));
      return {
        type: 'agent_prompted',
        agent: {
          terminal_id: `term-${pane.pane_id}`,
          agent_status: 'working',
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          pane_id: pane.pane_id,
          focused: pane.focused,
          revision,
        },
      };
    },
    'agent.wait': (p) => {
      const paneId = p.target;
      const statuses = ['idle', 'working', 'blocked', 'done', 'unknown'];
      const until = Array.isArray(p.until) && (p.until as string[]).length > 0 ? p.until as string[] : statuses;
      const deadline = Date.now() + (typeof p.timeout_ms === 'number' ? p.timeout_ms : 0);
      return new Promise((resolve) => {
        const tick = () => {
          const agent = live.agents.find((row) => row.pane_id === paneId);
          if (stopping || Date.now() >= deadline || (agent !== undefined && until.includes(agent.agent_status))) {
            resolve(agentView(paneId));
            return;
          }
          timers.push(setTimeout(tick, WAIT_POLL_MS));
        };
        tick();
      });
    },
    'agent.send_keys': (p) => {
      const agent = live.agents.find((row) => row.pane_id === p.target);
      const keys = Array.isArray(p.keys) ? p.keys as string[] : [];
      if (agent !== undefined) {
        const pane = live.panes.find((row) => row.pane_id === agent.pane_id);
        if (pane !== undefined) pane.text.push(keys.join(''));
        // Answering a blocked agent resolves it (6.4: the kit never interprets the TUI, the agent does).
        if (agent.agent_status === 'blocked' && keys.some((k) => k === 'y' || k === 'n')) {
          agent.detection = undefined;
          if (pane !== undefined) transition(pane, 'idle');
        }
      }
      return { target: p.target, keys };
    },
    'agent.list': () => ({ agents: live.agents.map((agent) => ({ ...agent })) }),
    'agent.get': (p) => {
      const agent = live.agents.find((row) => row.pane_id === p.target);
      if (agent === undefined) throw fail('agent_not_found', 'agent not found');
      return { agent };
    },

    'server.agent_manifests': () => ({ manifests: kinds.map((kind) => ({ agent: kind })) }),
    'plugin.list': (p) => {
      const plugins = live.plugins ?? [];
      const wanted = typeof p.plugin_id === 'string' ? p.plugin_id : undefined;
      const list = (wanted === undefined ? plugins : plugins.filter((row) => row.plugin_id === wanted))
        .map((row) => ({ ...row }));
      return { type: 'plugin_list', plugins: list };
    },
    'server.stop': () => {
      timers.push(setTimeout(() => { void shutdown(); }, 0));
      return {};
    },
  };

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
    for (const held of snapshotGates) held.release();
    snapshotGates = [];
    for (const held of ackGates) held.release();
    ackGates = [];
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    eventSubs.clear();
    filteredSubs.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unlinkQuiet(socketPath);
    options.onStop?.();
  }

  function handleLine(socket: Socket, line: string): void {
    let message: { id?: unknown; method?: unknown; params?: Params };
    try {
      message = JSON.parse(line);
    } catch {
      socket.destroy();
      return;
    }
    const id = message.id;
    const method = message.method;
    const params = message.params ?? {};
    if (typeof method !== 'string' || typeof params !== 'object' || params === null) {
      socket.destroy();
      return;
    }
    if (method === 'events.subscribe') {
      subscribe(socket, id, params);
      return;
    }
    const handler = methods[method];
    if (handler === undefined) {
      writeJson(socket, { id, error: { code: 'unknown_method', message: `unknown method ${method}` } });
      socket.end();
      return;
    }
    void Promise.resolve()
      .then(() => handler(params))
      .then((result) => writeJson(socket, { id, result }))
      .catch((error: Error & { code?: string }) => {
        writeJson(socket, { id, error: { code: error.code ?? 'error', message: error.message } });
      })
      .finally(() => socket.end());
  }

  // Subscription kinds use the schema's dot spelling (`pane.created`); live frames carry
  // the underscore const (`pane_created`, schema/SOURCE.md). The fake mirrors the real
  // server: it accepts both spellings in subscriptions and emits underscore wire frames.
  const wireName = (type: string): string => type.replace(/\./g, '_');

  function subscribe(socket: Socket, id: unknown, params: Params): void {
    const subs = Array.isArray(params.subscriptions) ? params.subscriptions as Params[] : [];
    const ackFailure = nextAckFailure;
    nextAckFailure = undefined;
    const invalid = (message: string, code = 'invalid_subscription') => {
      // A rejected subscribe answers `id: ""` once and the server closes; the client never retries it.
      writeJson(socket, { id: '', error: { code, message } });
      socket.end();
    };
    if (ackFailure !== undefined) {
      invalid(ackFailure.message, ackFailure.code);
      return;
    }
    for (const s of subs) {
      if (typeof s?.type !== 'string') return invalid('every subscription needs a type');
      const wire = wireName(s.type);
      if (FILTERED.has(wire) && typeof s.pane_id !== 'string') {
        return invalid(`${s.type} needs a pane_id`);
      }
      if (wire === 'pane_output_matched'
        && (typeof s.match !== 'object' || s.match === null || typeof s.source !== 'string')) {
        return invalid('pane.output_matched needs a pane_id, a match and a source');
      }
    }
    const filtered = subs.filter((s) => typeof s.type === 'string' && FILTERED.has(wireName(s.type)));
    if (filtered.length > 0) {
      const kinds = new Set(filtered.map((s) => wireName(s.type as string)));
      if (kinds.size > 1 || filtered.length !== subs.length) {
        return invalid(`${filtered[0].type as string} cannot share a batch`);
      }
    }
    const held = [...ackGates];
    const answer = () => {
      writeJson(socket, { id, result: { type: 'subscribed' } });
      if (filtered.length > 0) {
        for (const s of filtered) {
          filteredSubs.add({ socket, type: wireName(s.type as string), paneId: s.pane_id as string });
        }
        return;
      }
      eventSubs.add({ socket, kinds: new Set(subs.map((s) => wireName(s.type as string))) });
    };
    if (held.length === 0) {
      answer();
      return;
    }
    void Promise.all(held.map((h) => h.promise)).then(() => {
      if (!socket.destroyed) answer();
    });
  }

  // Payloads follow the pinned schema's event data (src/generated/events.ts).
  function emitEvent(type: string, data: Params): void {
    const wire = wireName(type);
    const frame = `${JSON.stringify({ event: wire, data: { type: wire, ...data } })}\n`;
    for (const sub of eventSubs) {
      if (sub.kinds.size > 0 && !sub.kinds.has(wire)) continue;
      try { sub.socket.write(frame); } catch { /* closed mid-emit */ }
    }
  }

  function emitStatus(paneId: string, agentStatus: string, revision: number): void {
    const agent = live.agents.find((row) => row.pane_id === paneId);
    const frame = `${JSON.stringify({
      event: 'pane_agent_status_changed',
      // Schema-shaped (PaneAgentStatusChangedEvent): the agent kind rides as a plain `agent`
      // string beside `workspace_id`, exactly like the real server's frame.
      data: { type: 'pane_agent_status_changed', pane_id: paneId, workspace_id: agent?.workspace_id,
        agent: agent?.agent, display_agent: agent?.display_agent, agent_status: agentStatus, revision },
    })}\n`;
    for (const sub of filteredSubs) {
      if (sub.type !== 'pane_agent_status_changed' || sub.paneId !== paneId) continue;
      try { sub.socket.write(frame); } catch { /* closed mid-emit */ }
    }
  }

  // Filtered emit: a frame for a filtered kind reaches only the sockets watching that pane.
  function emitFiltered(type: string, paneId: string, data: Params): void {
    const frame = `${JSON.stringify({ event: type, data: { type, ...data } })}\n`;
    for (const sub of filteredSubs) {
      if (sub.type !== type || sub.paneId !== paneId) continue;
      try { sub.socket.write(frame); } catch { /* closed mid-emit */ }
    }
  }

  function paneOf(paneId: unknown): FakePane {
    const pane = live.panes.find((row) => row.pane_id === paneId);
    if (pane === undefined) throw fail('pane_not_found', 'pane not found');
    return pane;
  }

  function agentOf(pane: FakePane): FakeAgent | undefined {
    return live.agents.find((row) => row.pane_id === pane.pane_id);
  }

  function agentView(paneId: unknown) {
    const agent = live.agents.find((row) => row.pane_id === paneId);
    if (agent !== undefined) return { agent: { ...agent } };
    const pane = live.panes.find((row) => row.pane_id === paneId);
    return { agent: { pane_id: paneId, agent_status: pane?.agent_status ?? 'unknown', interactive_ready: true } };
  }

  function transition(pane: FakePane, status: string): void {
    const agent = agentOf(pane);
    pane.agent_status = status;
    if (agent !== undefined) {
      agent.agent_status = status;
      agent.revision = ++live.nextRevision;
      pane.revision = agent.revision;
      // A blocked agent always has detection text (6.4 reads it as the question), whichever path
      // got it there — `agent.prompt` sets it first, `setStatus` arrives with none.
      if (status === 'blocked' && agent.detection === undefined) agent.detection = 'Allow this? (y/n)';
      if (status !== 'blocked') agent.detection = undefined;
      emitStatus(pane.pane_id, status, agent.revision);
    }
  }

  function paneText(pane: FakePane, source: unknown): string {
    if (source === 'detection') return agentOf(pane)?.detection ?? '';
    return pane.text.join('\n');
  }

  function label(p: Params): string | undefined {
    return typeof p.label === 'string' && p.label.length > 0 ? p.label : undefined;
  }

  // Placement env (K7): `workspace.create`, `tab.create`, `pane.split` and `worktree.create` carry
  // the start's env for the fresh pane's shell. The fake records it on the pane, where `pane.get`
  // surfaces it, so a test proves the pane received the env.
  function envOf(p: Params): Record<string, string> | undefined {
    if (typeof p.env !== 'object' || p.env === null || Array.isArray(p.env)) return undefined;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(p.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value;
    }
    return env;
  }

  function snapshotOf() {
    return {
      protocol: HERDR_PROTOCOL,
      version: HERDR_VERSION,
      workspaces: live.workspaces.map(workspaceView),
      tabs: live.tabs.map((tab) => ({ ...tab })),
      panes: live.panes.map(paneView),
      agents: live.agents.map((agent) => ({ ...agent })),
      layouts: [],
    };
  }

  function addWorkspace(labelText: string): FakeWorkspace {
    const n = live.nextWorkspace++;
    const workspaceId = `w${n}`;
    const workspace: FakeWorkspace = {
      workspace_id: workspaceId,
      label: labelText,
      focused: false,
      number: n,
      tokens: {},
      worktree: {
        // A unique key per plain workspace keeps it out of every worktree group; only
        // worktree.create links a checkout back into the root workspace's group.
        repo_key: `fake-${workspaceId}`,
        repo_name: 'fake-herdr',
        repo_root: labelText,
        checkout_path: labelText,
        is_linked_worktree: false,
      },
    };
    live.workspaces.push(workspace);
    return workspace;
  }

  function addTab(workspaceId: string, tabLabel: string): FakeWorld['tabs'][number] {
    const existing = live.tabs.filter((tab) => tab.workspace_id === workspaceId).length;
    const tab = { tab_id: `${workspaceId}:t${existing + 1}`, workspace_id: workspaceId, label: tabLabel };
    live.tabs.push(tab);
    return tab;
  }

  function addPane(tabId: string, workspaceId: string, paneCwd: string): FakePane {
    const paneNum = workspaceId === 'w1'
      ? live.nextPane++
      : live.panes.filter((row) => row.workspace_id === workspaceId).length + 1;
    const pane: FakePane = {
      pane_id: `${workspaceId}:p${paneNum}`,
      tab_id: tabId,
      workspace_id: workspaceId,
      cwd: paneCwd,
      foreground_cwd: paneCwd,
      label: 'zsh',
      terminal_title: `zsh · ${paneCwd}`,
      terminal_title_stripped: `zsh · ${paneCwd}`,
      focused: false,
      tokens: {},
      rect: { x: 0, y: 0, width: 80, height: 24 },
      text: ['ready.'],
      revision: 0,
      scroll: paneScroll(),
    };
    live.panes.push(pane);
    relayoutTab(live, tabId);
    return pane;
  }

  function removeTab(tabId: string): void {
    const paneIds = live.panes.filter((pane) => pane.tab_id === tabId).map((pane) => pane.pane_id);
    for (const paneId of paneIds) {
      live.panes = live.panes.filter((row) => row.pane_id !== paneId);
      live.agents = live.agents.filter((row) => row.pane_id !== paneId);
    }
    live.tabs = live.tabs.filter((tab) => tab.tab_id !== tabId);
  }

  function focusWorkspace(workspaceId: string): void {
    for (const workspace of live.workspaces) workspace.focused = workspace.workspace_id === workspaceId;
    const pane = live.panes.find((row) => row.workspace_id === workspaceId);
    if (pane !== undefined) focusPane(pane.pane_id);
  }

  function focusPane(paneId: string): void {
    const pane = live.panes.find((row) => row.pane_id === paneId);
    if (pane === undefined) return;
    for (const row of live.panes) row.focused = row.pane_id === paneId;
    for (const workspace of live.workspaces) workspace.focused = workspace.workspace_id === pane.workspace_id;
  }

  function tabLayout(tabId: string) {
    const panes = live.panes.filter((pane) => pane.tab_id === tabId);
    let width = 80;
    let height = 24;
    for (const pane of panes) {
      width = Math.max(width, pane.rect.x + pane.rect.width);
      height = Math.max(height, pane.rect.y + pane.rect.height);
    }
    const focused = panes.find((pane) => pane.focused) ?? panes[0];
    return {
      workspace_id: focused?.workspace_id,
      tab_id: tabId,
      focused_pane_id: focused?.pane_id,
      zoomed: live.zoomed,
      area: { x: 0, y: 0, width, height },
      panes: panes.map((pane) => ({ pane_id: pane.pane_id, focused: pane.focused, rect: pane.rect })),
    };
  }

  function workspaceView(workspace: FakeWorld['workspaces'][number]) {
    const tabs = live.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
    const focusedPane = live.panes.find((pane) => pane.workspace_id === workspace.workspace_id && pane.focused);
    return {
      workspace_id: workspace.workspace_id,
      label: workspace.label,
      focused: workspace.focused,
      number: workspace.number,
      tab_count: tabs.length,
      active_tab_id: focusedPane?.tab_id ?? tabs[0]?.tab_id,
      ...(Object.keys(workspace.tokens).length === 0 ? {} : { tokens: { ...workspace.tokens } }),
      ...(workspace.worktree === undefined ? {} : { worktree: workspace.worktree }),
    };
  }

  function tabView(tab: FakeWorld['tabs'][number]) {
    return {
      ...tab,
      pane_count: live.panes.filter((pane) => pane.tab_id === tab.tab_id).length,
    };
  }

  return {
    socketPath,
    bin,
    world: live,
    agentStartFaults,
    emit(event) {
      // Filtered kinds route to the sockets watching that pane only; every other kind
      // broadcasts to the batch subscriptions holding it. Either spelling is accepted and
      // frames ride the live underscore wire spelling. Emitting never mutates the world —
      // `setStatus` and the `pane.*` methods are the state changes; this only routes frames.
      const wire = wireName(event.type);
      if (FILTERED.has(wire) && typeof event.pane_id === 'string') {
        if (wire === 'pane_agent_status_changed') {
          emitStatus(event.pane_id, String(event.agent_status ?? 'unknown'), Number(event.revision ?? 0));
          return;
        }
        const { type: _type, ...data } = event;
        emitFiltered(wire, event.pane_id, data);
        return;
      }
      const { type, ...data } = event;
      emitEvent(type, data);
    },
    setStatus(paneId, status) {
      const pane = live.panes.find((row) => row.pane_id === paneId);
      if (pane !== undefined) transition(pane, status);
    },
    watching: ((paneId?: string): string[] | boolean => {
      const watched = [...new Set([...filteredSubs].map((sub) => sub.paneId))].sort();
      if (paneId === undefined) return watched;
      return watched.includes(paneId);
    }) as FakeHerdr['watching'],
    snapshotCount() {
      return snapshots;
    },
    holdSnapshot() {
      return gate(snapshotGates);
    },
    failNextSnapshot(code = 'error', message = 'the next snapshot fails') {
      nextSnapshotFailure = { code, message };
    },
    holdAck() {
      return gate(ackGates);
    },
    failNextAck(code = 'invalid_subscription', message = 'the next subscribe is rejected') {
      nextAckFailure = { code, message };
    },
    subscriptionCount() {
      const held = new Set<object>();
      for (const sub of eventSubs) held.add(sub.socket);
      for (const sub of filteredSubs) held.add(sub.socket);
      return held.size;
    },
    stop: shutdown,
  };
}

function paneView(pane: FakePane) {
  return {
    pane_id: pane.pane_id,
    tab_id: pane.tab_id,
    workspace_id: pane.workspace_id,
    cwd: pane.cwd,
    foreground_cwd: pane.foreground_cwd,
    ...(pane.agent_status === undefined ? {} : { agent_status: pane.agent_status }),
    label: pane.label,
    terminal_title: pane.terminal_title,
    terminal_title_stripped: pane.terminal_title_stripped,
    focused: pane.focused,
    ...(pane.env === undefined ? {} : { env: { ...pane.env } }),
    terminal_id: `term-${pane.pane_id}`,
    revision: pane.revision,
    scroll: { ...pane.scroll },
    ...(Object.keys(pane.tokens).length === 0 ? {} : { tokens: pane.tokens }),
  };
}

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function writeJson(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function unlinkQuiet(path: string): void {
  try { unlinkSync(path); } catch { /* absent */ }
}

function listen(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
}
