// The fake Herdr control plane (docs/runtime-kits.md 6.8): NDJSON JSON-RPC on a unix socket, one
// request per connection — the server closes after answering; only `events.subscribe` is held open.
// Ported from muxr `perf/fake-herdr/server.mjs` with the UI plugins, title churn, graphics and perf
// byte rates removed.
import { mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { HERDR_PROTOCOL, HERDR_VERSION } from '../../constants.ts';
import { writeBinShim } from './bin.ts';
import { agentRecord, createWorld, freezeWorld, relayoutTab,
  type FakeAgent, type FakePane, type FakeWorld, type FakeWorkspace } from './world.ts';

const PROMPT_SETTLE_MS = 50;   // 6.8: the agent settles 50 ms after a prompt
const WAIT_POLL_MS = 5;

export type FakeHerdrOptions = {
  dir: string;                        // test-owned scratch dir; the fake writes nothing outside it
  socketPath?: string;                // default <dir>/herdr.sock
  world?: { cwd?: string; kinds?: readonly string[] };
  onStop?: () => void;                // called after shutdown completes (the `server` bin verb exits on it)
};

export type FakeHerdr = {
  socketPath: string;
  bin: string;
  world: FakeWorld;                   // frozen clone of the world at start, for assertions
  emit(event: { type: string } & Record<string, unknown>): void;
  setStatus(paneId: string, status: string): void;
  subscriptionCount(): number;        // distinct sockets holding a subscription (batch + status)
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

  const live: LiveWorld = Object.assign(createWorld({ cwd, kinds }), {
    nextPane: 3,
    nextWorkspace: 2,
    nextRevision: 0,
    zoomed: false,
  });

  const sockets = new Set<Socket>();
  const eventSubs = new Set<{ socket: Socket; kinds: Set<string> }>();
  const statusSubs = new Set<{ socket: Socket; paneId: string }>();
  const timers: NodeJS.Timeout[] = [];
  let stopping = false;

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
      for (const sub of statusSubs) if (sub.socket === socket) statusSubs.delete(sub);
    });
    socket.on('error', () => {});
  });

  unlinkQuiet(socketPath);
  await listen(server, socketPath);
  const bin = writeBinShim({ dir, socketPath });

  const methods: Record<string, (params: Params) => unknown | Promise<unknown>> = {
    ping: () => ({ protocol: HERDR_PROTOCOL, version: HERDR_VERSION }),

    'session.snapshot': () => ({ snapshot: snapshotOf() }),

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
      emitEvent('workspace.created', { workspace: workspaceView(workspace) });
      return { workspace: { ...workspaceView(workspace), worktree: workspace.worktree } };
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
      const pane = paneOf(p.pane_id);
      const kind = typeof p.kind === 'string' && p.kind.length > 0 ? p.kind : 'pi';
      const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : kind;
      pane.agent_status = 'idle';
      pane.label = name;
      pane.terminal_title = `${kind} · ${name}`;
      pane.terminal_title_stripped = pane.terminal_title;
      const agent = agentRecord({
        paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id, cwd: pane.cwd,
        name, kind, revision: ++live.nextRevision,
      });
      const index = live.agents.findIndex((row) => row.pane_id === pane.pane_id);
      if (index === -1) live.agents.push(agent);
      else live.agents[index] = agent;
      emitEvent('pane.agent_detected', { pane_id: pane.pane_id, workspace_id: pane.workspace_id, agent: kind });
      return { agent };
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
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    eventSubs.clear();
    statusSubs.clear();
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
    const invalid = (message: string) => {
      // A rejected subscribe answers `id: ""` once and the server closes; the client never retries it.
      writeJson(socket, { id: '', error: { code: 'invalid_subscription', message } });
      socket.end();
    };
    for (const s of subs) {
      if (typeof s?.type !== 'string') return invalid('every subscription needs a type');
      if (wireName(s.type) === 'pane_agent_status_changed' && typeof s.pane_id !== 'string') {
        return invalid('pane.agent_status_changed needs a pane_id');
      }
    }
    const filtered = subs.filter((s) => typeof s.type === 'string' && wireName(s.type) === 'pane_agent_status_changed');
    if (filtered.length > 0 && filtered.length !== subs.length) {
      return invalid('pane.agent_status_changed cannot share a batch');
    }
    writeJson(socket, { id, result: { type: 'subscribed' } });
    if (filtered.length > 0) {
      for (const s of filtered) statusSubs.add({ socket, paneId: s.pane_id as string });
      return;
    }
    eventSubs.add({ socket, kinds: new Set(subs.map((s) => wireName(s.type as string))) });
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
    const frame = `${JSON.stringify({
      event: 'pane_agent_status_changed',
      data: { type: 'pane_agent_status_changed', pane_id: paneId, agent_status: agentStatus, revision },
    })}\n`;
    for (const sub of statusSubs) {
      if (sub.paneId !== paneId) continue;
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

  function snapshotOf() {
    return {
      workspaces: live.workspaces.map(workspaceView),
      tabs: live.tabs.map((tab) => ({ ...tab })),
      panes: live.panes.map(paneView),
      agents: live.agents.map((agent) => ({ ...agent })),
    };
  }

  function addWorkspace(labelText: string): FakeWorkspace {
    const workspaceId = `w${live.nextWorkspace++}`;
    const workspace: FakeWorkspace = {
      workspace_id: workspaceId,
      label: labelText,
      focused: false,
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
      tab_count: tabs.length,
      active_tab_id: focusedPane?.tab_id ?? tabs[0]?.tab_id,
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
    world: freezeWorld(live),
    emit(event) {
      if (wireName(event.type) === 'pane_agent_status_changed' && typeof event.pane_id === 'string') {
        emitStatus(event.pane_id, String(event.agent_status ?? 'unknown'), Number(event.revision ?? 0));
        return;
      }
      const { type, ...data } = event;
      emitEvent(type, data);
    },
    setStatus(paneId, status) {
      const pane = live.panes.find((row) => row.pane_id === paneId);
      if (pane !== undefined) transition(pane, status);
    },
    subscriptionCount() {
      const held = new Set<object>();
      for (const sub of eventSubs) held.add(sub.socket);
      for (const sub of statusSubs) held.add(sub.socket);
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
