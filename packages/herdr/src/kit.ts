import { HERDR_PROTOCOL } from './constants.ts';
import { Supervisor } from './supervise.ts';
import type {
  AgentRef, AgentStatus, BlockedAgent, HerdrEvent, HerdrEventName, HerdrEventOf, HerdrKitOptions, HerdrMethod,
  HerdrParams, HerdrResult, HerdrSnapshot, HerdrState, HerdrSubscription, PromptReceipt, StartAgent, TerminalSession,
  HerdrTransport,
} from './types.ts';

const kinds = ['pane.agent_detected', 'pane.created', 'pane.closed', 'pane.moved', 'pane.exited', 'pane.updated',
  'workspace.created', 'workspace.closed', 'workspace.renamed', 'workspace.updated', 'tab.created', 'tab.closed', 'tab.renamed'];
const todo = (what: string): never => { throw new Error(`@byokit/herdr: ${what} is not built yet (docs/runtime-kits.md §11.3).`); };
type Raw = Record<string, any>;
const empty = (): HerdrSnapshot => ({ connected: false, workspaces: [] });

export class HerdrKit {
  private readonly supervisor: Supervisor;
  private transport?: HerdrTransport;
  private current: HerdrState = { phase: 'stopped' };
  private tree = empty();
  private listeners = new Set<(s: HerdrSnapshot) => void>();
  private stops = new Set<() => void>();
  private statusStops = new Set<() => void>();
  private generation = 0;
  private readonly o: HerdrKitOptions;
  constructor(o: HerdrKitOptions) {
    this.o = o;
    this.supervisor = new Supervisor(o, (s) => { this.current = s; o.onState?.(s); });
  }
  get state(): HerdrState { return this.current; }
  private publish() { for (const fn of this.listeners) fn(this.snapshot()); }
  private update(e: HerdrEvent) {
    const raw = e as Raw;
    const paneId = raw.pane_id ?? raw.pane?.pane_id;
    const pane = this.tree.workspaces.flatMap((w) => w.tabs).flatMap((t) => t.panes).find((p) => p.id === paneId);
    if (pane && (e.type === 'pane.agent_status_changed' || e.type === 'pane.agent_detected' || e.type === 'pane.updated')) {
      const a = raw.agent ?? raw;
      pane.agent = { status: 'unknown', revision: 0, ...pane.agent,
        ...(a.agent !== undefined ? { kind: a.agent } : {}),
        ...(a.agent_status !== undefined ? { status: a.agent_status } : {}),
        ...(a.revision !== undefined ? { revision: a.revision } : {}),
        ...(a.launch_pending !== undefined ? { launchPending: a.launch_pending } : {}),
        ...(a.interactive_ready !== undefined ? { interactiveReady: a.interactive_ready } : {}),
      };
    }
    if (e.type === 'pane.closed') for (const tab of this.tree.workspaces.flatMap((w) => w.tabs)) tab.panes = tab.panes.filter((p) => p.id !== paneId);
    if (e.type === 'tab.closed') for (const w of this.tree.workspaces) w.tabs = w.tabs.filter((t) => t.id !== raw.tab_id);
    if (e.type === 'workspace.closed') this.tree.workspaces = this.tree.workspaces.filter((w) => w.id !== raw.workspace_id);
    this.publish();
  }
  private async bootstrap(token: number, buffered: HerdrEvent[]): Promise<void> {
    const result = await this.transport!.call('session.snapshot', {}) as Raw;
    if (token !== this.generation) return;
    const snap = result.snapshot as Raw;
    if ((snap.protocol !== undefined && snap.protocol !== HERDR_PROTOCOL) ||
        (result.protocol !== undefined && result.protocol !== HERDR_PROTOCOL)) {
      this.current = { phase: 'needs-update', why: 'version' }; this.o.onState?.(this.current);
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
    this.publish();
    for (const pane of this.tree.workspaces.flatMap((w) => w.tabs).flatMap((t) => t.panes)) {
      if (!pane.agent) continue;
      const stop = this.transport!.subscribe([{ type: 'pane.agent_status_changed', pane_id: pane.id }],
        (e) => this.update(e), () => {});
      this.stops.add(stop);
      this.statusStops.add(stop);
    }
    this.current = { phase: 'ready' }; this.o.onState?.(this.current);
  }
  async start(): Promise<void> {
    const token = ++this.generation;
    this.transport = await this.supervisor.start();
    const buffered: HerdrEvent[] = [];
    let booting = true;
    const stop = this.transport.subscribe(kinds.map((type) => ({ type })), (e) => {
      if (booting) buffered.push(e); else this.update(e);
    }, () => {});
    this.stops.add(stop);
    const control = stop as typeof stop & { ready?: Promise<void>; onReconnect?: (fn: () => void) => void };
    control.onReconnect?.(() => {
      if (token !== this.generation) return;
      booting = true;
      this.current = { phase: 'reconnecting' }; this.o.onState?.(this.current);
      void this.bootstrap(token, buffered).then(() => { booting = false; }).catch(() => {});
    });
    await control.ready;
    await this.bootstrap(token, buffered);
    booting = false;
  }
  async stop(): Promise<void> {
    ++this.generation;
    for (const stop of this.stops) stop(); this.stops.clear(); this.statusStops.clear();
    await this.supervisor.stop();
    this.transport = undefined;
    this.tree = empty(); this.publish();
  }
  call<M extends HerdrMethod>(method: M, params: HerdrParams<M>, o?: { timeoutMs?: number }): Promise<HerdrResult<M>> {
    if (!this.transport) return Promise.reject(new Error('herdr: not connected'));
    return this.transport.call(method, params as Record<string, unknown>, o?.timeoutMs) as Promise<HerdrResult<M>>;
  }
  subscribe<E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void): () => void {
    if (!this.transport) throw new Error('herdr: not connected');
    return this.transport.subscribe(subs, on as (e: HerdrEvent) => void, () => {});
  }
  cli(args: string[], o?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> { return todo('cli (H4)'); }
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession { return todo('terminal (H4)'); }
  snapshot(): HerdrSnapshot { return structuredClone(this.tree); }
  onChange(fn: (s: HerdrSnapshot) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  startAgent(o: StartAgent): Promise<AgentRef> { return todo('startAgent (H5)'); }
  prompt(target: AgentRef, text: string, o?: { wait?: { until?: AgentStatus[]; timeoutMs: number } }): Promise<PromptReceipt> { return todo('prompt (H5)'); }
  sendKeys(target: AgentRef, keys: string[]): Promise<void> { return todo('sendKeys (H5)'); }
  wait(target: AgentRef, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus> { return todo('wait (H5)'); }
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number; ansi?: boolean }): Promise<{ text: string; truncated: boolean }> { return todo('read (H5)'); }
  blocked(): BlockedAgent[] { return todo('blocked (H5)'); }
  onBlocked(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void { return todo('onBlocked (H5)'); }
  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void> { return todo('answer (H5)'); }
  closePane(paneId: string): Promise<void> { return todo('closePane (H5)'); }
  closeTab(tabId: string): Promise<void> { return todo('closeTab (H5)'); }
  closeWorkspace(workspaceId: string): Promise<void> { return todo('closeWorkspace (H5)'); }
  agentKinds(): Promise<string[]> { return todo('agentKinds (H5)'); }
  installedAgentKinds(kinds: readonly string[], o: { path: string[] }): string[] { return todo('installedAgentKinds (H5)'); }
}
