import { createAgents, type Call } from './agents.ts';
import { Blocked } from './approvals.ts';
import { runCli } from './cli.ts';
import { openTerminal } from './terminal.ts';
import { HERDR_PROTOCOL } from './constants.ts';
import { closePane, closeTab, closeWorkspace } from './close.ts';
import { Supervisor } from './supervise.ts';
import type {
  AgentRef, AgentStatus, BlockedAgent, HerdrEvent, HerdrEventName, HerdrEventOf, HerdrKitOptions, HerdrMethod,
  HerdrParams, HerdrResult, HerdrSnapshot, HerdrState, HerdrSubscription, PromptReceipt, StartAgent, TerminalSession,
  HerdrTransport,
} from './types.ts';

const kinds = ['pane.agent_detected', 'pane.created', 'pane.closed', 'pane.moved', 'pane.exited', 'pane.updated',
  'workspace.created', 'workspace.closed', 'workspace.renamed', 'workspace.updated', 'tab.created', 'tab.closed', 'tab.renamed'];
type Raw = Record<string, any>;
const empty = (): HerdrSnapshot => ({ connected: false, workspaces: [] });

export class HerdrKit {
  private readonly supervisor: Supervisor;
  private transport?: HerdrTransport;
  private current: HerdrState = { phase: 'stopped' };
  private tree = empty();
  private listeners = new Set<(s: HerdrSnapshot) => void>();
  private rawListeners = new Set<(e: HerdrEvent) => void>();
  private statusReadyPromise: Promise<void> = Promise.resolve();
  private statusReadyResolve?: () => void;
  private stops = new Set<() => void>();
  private statusStops = new Set<() => void>();
  private generation = 0;
  private readonly o: HerdrKitOptions;
  private readonly callAny: Call = (method, params, timeoutMs) =>
    this.call(method as never, params as never, timeoutMs === undefined ? undefined : { timeoutMs });
  private readonly agents: ReturnType<typeof createAgents>;
  private readonly blockedList: Blocked;
  constructor(o: HerdrKitOptions) {
    this.o = o;
    this.supervisor = new Supervisor(o, (s) => { this.current = s; o.onState?.(s); });
    this.agents = createAgents({ call: this.callAny, snapshot: () => this.snapshot() });
    this.blockedList = new Blocked({ call: this.callAny });
  }
  get state(): HerdrState { return this.current; }
  private publish() { for (const fn of this.listeners) fn(this.snapshot()); }
  private emitRaw(e: HerdrEvent) { for (const fn of [...this.rawListeners]) fn(e); }
  private update(e: HerdrEvent) {
    const raw = e as Raw;
    // The pinned schema spells subscription kinds with dots (`pane.created`) while live
    // frames carry the underscore const (`pane_created`, schema/SOURCE.md); match both.
    const name = typeof e.type === 'string' ? e.type.replace(/_/g, '.') : '';
    const paneId = (raw.pane_id ?? raw.pane?.pane_id) as string | undefined;
    let owner: { workspaceId: string; tabId: string } | undefined;
    let pane: HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number] | undefined;
    for (const w of this.tree.workspaces) {
      for (const t of w.tabs) {
        const found = t.panes.find((p) => p.id === paneId);
        if (found !== undefined) { pane = found; owner = { workspaceId: w.id, tabId: t.id }; }
      }
    }
    if (pane !== undefined && owner !== undefined &&
        (name === 'pane.agent.status.changed' || name === 'pane.agent.detected' || name === 'pane.updated')) {
      const a = raw.agent ?? raw.pane ?? raw;
      pane.agent = { status: 'unknown', revision: 0, ...pane.agent,
        ...(a.agent !== undefined ? { kind: a.agent } : {}),
        ...(a.agent_status !== undefined ? { status: a.agent_status } : {}),
        ...(a.revision !== undefined ? { revision: a.revision } : {}),
        ...(a.launch_pending !== undefined ? { launchPending: a.launch_pending } : {}),
        ...(a.interactive_ready !== undefined ? { interactiveReady: a.interactive_ready } : {}),
      };
      this.blockedList.update(paneId as string, pane.agent, owner);
    }
    if (name === 'pane.closed') {
      this.blockedList.update(paneId as string, undefined, owner ?? { workspaceId: '', tabId: '' });
      for (const tab of this.tree.workspaces.flatMap((w) => w.tabs)) tab.panes = tab.panes.filter((p) => p.id !== paneId);
    }
    if (name === 'tab.closed') for (const w of this.tree.workspaces) w.tabs = w.tabs.filter((t) => t.id !== raw.tab_id);
    if (name === 'workspace.closed') this.tree.workspaces = this.tree.workspaces.filter((w) => w.id !== raw.workspace_id);
    this.publish();
  }
  private async bootstrap(token: number, buffered: HerdrEvent[]): Promise<void> {
    let resolveStatus!: () => void;
    const statusReady = new Promise<void>((resolve) => { resolveStatus = resolve; });
    this.statusReadyPromise = statusReady;
    this.statusReadyResolve = resolveStatus;
    let result: Raw;
    try {
      result = await this.transport!.call('session.snapshot', {}) as Raw;
    } catch (error) {
      resolveStatus();
      throw error;
    }
    if (token !== this.generation) { resolveStatus(); return; }
    const snap = result.snapshot as Raw;
    if ((snap.protocol !== undefined && snap.protocol !== HERDR_PROTOCOL) ||
        (result.protocol !== undefined && result.protocol !== HERDR_PROTOCOL)) {
      this.current = { phase: 'needs-update', why: 'version' }; this.o.onState?.(this.current);
      resolveStatus();
      throw new Error('herdr: snapshot protocol mismatch');
    }
    const workspaces = (snap.workspaces as Raw[]).map((w) => ({
      id: w.workspace_id as string, label: w.label as string,
      tabs: (snap.tabs as Raw[]).filter((t) => t.workspace_id === w.workspace_id).map((t) => ({
        id: t.tab_id as string, label: t.label as string,
        panes: (snap.panes as Raw[]).filter((p) => p.tab_id === t.tab_id).map((p) => {
          const a = (snap.agents as Raw[]).find((a) => a.pane_id === p.pane_id);
          return { id: p.pane_id as string, cwd: p.cwd as string | undefined, ...(a ? { agent: {
            kind: a.agent as string | undefined, name: a.name as string | undefined,
            status: (a.agent_status ?? 'unknown') as AgentStatus, revision: (a.revision ?? 0) as number,
            launchPending: a.launch_pending as boolean | undefined, interactiveReady: a.interactive_ready as boolean | undefined,
          } } : {}) };
        }),
      })),
    }));
    for (const stop of this.statusStops) { stop(); this.stops.delete(stop); }
    this.statusStops.clear();
    this.tree = { connected: true, workspaces };
    for (const event of buffered.splice(0)) this.update(event);
    // Agents already blocked in the snapshot join the list; entries whose pane is gone resolve.
    for (const entry of this.blockedList.list()) {
      const still = this.tree.workspaces.some((w) => w.tabs.some((t) => t.panes.some((p) => p.id === entry.paneId)));
      if (!still) this.blockedList.update(entry.paneId, undefined, entry);
    }
    for (const w of this.tree.workspaces) for (const t of w.tabs) for (const p of t.panes) {
      if (p.agent?.status === 'blocked') this.blockedList.update(p.id, p.agent, { workspaceId: w.id, tabId: t.id });
    }
    this.publish();
    const statusAcks: Promise<unknown>[] = [];
    for (const pane of this.tree.workspaces.flatMap((w) => w.tabs).flatMap((t) => t.panes)) {
      if (!pane.agent) continue;
      const stop = this.transport!.subscribe([{ type: 'pane.agent_status_changed', pane_id: pane.id }],
        (e) => { this.emitRaw(e); this.update(e); }, () => {});
      this.stops.add(stop);
      this.statusStops.add(stop);
      const ready = (stop as typeof stop & { ready?: Promise<unknown> }).ready;
      if (ready) statusAcks.push(ready);
    }
    void Promise.allSettled(statusAcks).then(() => { if (token === this.generation) resolveStatus(); });
    this.current = { phase: 'ready' }; this.o.onState?.(this.current);
  }
  /**
   * Connect and bootstrap. Non-fatal: a rejected `start()` (e.g. `failed/socket` while Herdr is
   * down) leaves the kit stopped, and `start()` may be called again afterwards — the host comes up
   * while Herdr is down by retrying `start()` in a backoff loop until it reaches `ready`.
   */
  async start(): Promise<void> {
    const token = ++this.generation;
    this.transport = await this.supervisor.start();
    const buffered: HerdrEvent[] = [];
    let booting = true;
    const refresh = () => {
      if (token !== this.generation || booting) return;
      booting = true;
      void this.bootstrap(token, buffered).then(() => { booting = false; }).catch(() => { booting = false; });
    };
    const stop = this.transport.subscribe(kinds.map((type) => ({ type })), (e) => {
      // Raw tap (K3): fire on arrival, before buffering/refresh/update, so listeners see every
      // wire payload (pane.moved.previous_pane_id, workspace.*) exactly once. Buffered replays
      // in bootstrap() call update() only and never re-emit.
      this.emitRaw(e);
      // Live frames carry the underscore spelling (`pane_created`); see update().
      const name = typeof e.type === 'string' ? e.type.replace(/_/g, '.') : '';
      if (booting) buffered.push(e);
      else if (name === 'pane.agent.detected' || /^(pane|tab|workspace)\.(created|closed|moved|renamed)$/.test(name)) {
        buffered.push(e); refresh();
      } else this.update(e);
    }, () => {});
    this.stops.add(stop);
    try {
      const control = stop as typeof stop & { ready?: Promise<boolean>; onReconnect?: (fn: () => void) => void;
        onDisconnect?: (fn: () => void) => void };
      control.onDisconnect?.(() => {
        if (token !== this.generation) return;
        this.current = { phase: 'reconnecting' }; this.o.onState?.(this.current);
        this.tree.connected = false; this.publish();
      });
      control.onReconnect?.(refresh);
      if (await control.ready === false) throw new Error('herdr: event subscription rejected');
      await this.bootstrap(token, buffered);
      booting = false;
    } catch (error) {
      // The attempt owns this subscription: drop it so a retried `start()` dials clean.
      this.stops.delete(stop);
      stop();
      throw error;
    }
  }
  async stop(): Promise<void> {
    ++this.generation;
    this.statusReadyResolve?.();
    this.statusReadyPromise = Promise.resolve();
    this.statusReadyResolve = undefined;
    for (const entry of this.blockedList.list()) this.blockedList.update(entry.paneId, undefined, entry);
    for (const stop of this.stops) stop(); this.stops.clear(); this.statusStops.clear();
    await this.supervisor.stop();
    this.transport = undefined;
    this.tree = empty(); this.publish();
  }
  call<M extends HerdrMethod>(method: M, params: HerdrParams<M>, o?: { timeoutMs?: number }): Promise<HerdrResult<M>> {
    if (!this.transport) return Promise.reject(new Error('herdr: not connected'));
    const values = params as Record<string, unknown>;
    const wait = values.wait as { timeout_ms?: number } | undefined;
    const timeout = o?.timeoutMs ?? (method === 'agent.wait' && typeof values.timeout_ms === 'number'
      ? values.timeout_ms + 5000 : method === 'agent.prompt' && typeof wait?.timeout_ms === 'number'
        ? wait.timeout_ms + 5000 : undefined);
    return this.transport.call(method, values, timeout) as Promise<HerdrResult<M>>;
  }
  subscribe<E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void): () => void {
    if (!this.transport) throw new Error('herdr: not connected');
    return this.transport.subscribe(subs, on as (e: HerdrEvent) => void, () => {});
  }
  cli(args: string[], o?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> { return runCli(this.o.bin, this.supervisor.env(), args, o?.timeoutMs); }
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession { return openTerminal(this.o.bin, this.supervisor.env(), paneId, o); }
  snapshot(): HerdrSnapshot { return structuredClone(this.tree); }
  onChange(fn: (s: HerdrSnapshot) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /**
   * Raw event tap (K3): delivers every event arriving on the kit's own batch and per-pane
   * status sockets, with wire payloads intact (`pane.moved.previous_pane_id`, `workspace.*`).
   * Fires on arrival — before the snapshot update/refresh for that event — so a listener sees
   * the frame even when it triggers a re-bootstrap. Buffered replays never re-fire. Sockets
   * opened via `subscribe()` are NOT tapped; `onEvent` itself opens no socket.
   */
  onEvent(fn: (e: HerdrEvent) => void): () => void { this.rawListeners.add(fn); return () => { this.rawListeners.delete(fn); }; }
  /**
   * Ready signal for the status-watch set (K3): resolves when the latest bootstrap's per-pane
   * `pane.agent_status_changed` subscriptions have acked (immediately when no pane needs one).
   * Await after `start()` — and after any reconnect-driven re-bootstrap — before relying on
   * status events instead of opening a second watch.
   */
  statusWatchReady(): Promise<void> { return this.statusReadyPromise; }
  startAgent(o: StartAgent): Promise<AgentRef> { return this.agents.startAgent(o); }
  prompt(target: AgentRef, text: string, o?: { wait?: { until?: AgentStatus[]; timeoutMs: number } }): Promise<PromptReceipt> { return this.agents.prompt(target, text, o); }
  sendKeys(target: AgentRef, keys: string[]): Promise<void> { return this.agents.sendKeys(target, keys); }
  wait(target: AgentRef, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus> { return this.agents.wait(target, o); }
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number; ansi?: boolean }): Promise<{ text: string; truncated: boolean }> { return this.agents.read(paneId, o); }
  blocked(): BlockedAgent[] { return this.blockedList.list(); }
  onBlocked(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void { return this.blockedList.on(fn); }
  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void> { return this.blockedList.answer(paneId, keys, o); }
  closePane(paneId: string): Promise<void> { return closePane(this.callAny, paneId); }
  closeTab(tabId: string): Promise<void> { return closeTab(this.callAny, tabId); }
  closeWorkspace(workspaceId: string): Promise<void> { return closeWorkspace(this.callAny, workspaceId); }
  agentKinds(): Promise<string[]> { return this.agents.agentKinds(); }
  installedAgentKinds(kinds: readonly string[], o: { path: string[]; aliases?: Record<string, string[]> }): string[] { return this.agents.installedAgentKinds(kinds, o); }
}
