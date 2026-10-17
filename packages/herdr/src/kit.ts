import { createAccountPanes } from './accounts.ts';
import { createAgents, type Call } from './agents.ts';
import { Blocked } from './approvals.ts';
import { runCli } from './cli.ts';
import { openTerminal } from './terminal.ts';
import { protocolBounds } from './constants.ts';
import { closePane, closeTab, closeWorkspace } from './close.ts';
import { Supervisor } from './supervise.ts';
import type {
  AgentCliSignIn, AgentReadiness, AgentStartEvent, AgentStatusOptions, AgentRef, AgentSessionRef, AgentStatus, BlockedAgent, HerdrEvent, HerdrEventName, HerdrEventOf, HerdrKitOptions, HerdrMethod,
  HerdrLayout, HerdrParams, HerdrRename, HerdrResult, HerdrSnapshot, HerdrSnapshotAgent, HerdrSnapshotPane, HerdrSnapshotWorkspace, HerdrState, HerdrSubscription, HerdrSubscribeStop, HerdrTarget, PlaceRef, PlaceRequest, PromptReceipt, StartAgent, TerminalSession,
  HerdrTransport, Move, MoveToAccount, MoveToAccountResult, MoveResult, OpenSignInTab,
} from './types.ts';
import type { AgentTurnEnd, AgentTurnOptions } from './types.ts';
import { createTurns } from './turns.ts';

const kinds = ['pane.agent_detected', 'pane.created', 'pane.closed', 'pane.focused', 'pane.moved', 'pane.exited', 'pane.updated',
  'workspace.created', 'workspace.closed', 'workspace.focused', 'workspace.renamed', 'workspace.updated',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed'];
type Raw = Record<string, any>;
const empty = (): HerdrSnapshot => ({ connected: false, revision: 0, workspaces: [] });

// Structural events can add or remove panes/tabs/workspaces, which `update()` replays in place and
// cannot do; each one re-bootstraps so the tree read from the server carries the change.
const structural = (name: string): boolean =>
  name === 'pane.agent.detected' || /^(pane|tab|workspace)\.(created|closed|moved|renamed)$/.test(name);

type Waiter = { resolve: () => void; reject: (reason: unknown) => void };
const notConnected = (): Error => Object.assign(new Error('herdr: not connected'), { code: 'not_connected' });

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);

/** A pane's `agent_status`, accepted only when it is one of the five statuses. */
function statusOf(v: unknown): AgentStatus | undefined {
  return typeof v === 'string' && STATUSES.has(v) ? v as AgentStatus : undefined;
}

/** True when a pane payload names the agent itself (its kind or session), not merely the
 *  `agent_status`/`revision` every pane record carries. A plain shell's `pane.updated` carries
 *  neither, so it must never invent an agent with status `unknown`. */
function namesAgent(p: Raw): boolean {
  return str(p.agent) !== undefined || sessionOf(p.agent_session) !== undefined;
}

function tokensOf(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sessionOf(v: unknown): AgentSessionRef | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Raw;
  if (typeof r.source !== 'string' || typeof r.agent !== 'string' ||
      typeof r.kind !== 'string' || typeof r.value !== 'string') return undefined;
  return { source: r.source, agent: r.agent, kind: r.kind, value: r.value };
}

// Only `checkout_path` is required: Herdr reports partial worktree records (muxr mirrors
// `checkout_path` alone), so every other field is carried when the wire has it.
function worktreeOf(v: unknown): HerdrSnapshotWorkspace['worktree'] {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Raw;
  if (typeof r.checkout_path !== 'string') return undefined;
  return {
    checkoutPath: r.checkout_path,
    ...(typeof r.repo_key === 'string' ? { repoKey: r.repo_key } : {}),
    ...(typeof r.repo_name === 'string' ? { repoName: r.repo_name } : {}),
    ...(typeof r.repo_root === 'string' ? { repoRoot: r.repo_root } : {}),
    ...(typeof r.is_linked_worktree === 'boolean' ? { isLinkedWorktree: r.is_linked_worktree } : {}),
  };
}

/** Agent records merge partial events (`{ ...current, ...incoming }`): every field present wins. */
function mergeAgent(current: HerdrSnapshotAgent | undefined, a: Raw): HerdrSnapshotAgent {
  const kind = str(a.agent);
  const name = str(a.name);
  const displayAgent = str(a.display_agent);
  const title = str(a.title);
  const cwd = str(a.cwd);
  const foregroundCwd = str(a.foreground_cwd);
  const session = sessionOf(a.agent_session);
  return {
    status: 'unknown', revision: 0, ...current,
    ...(kind !== undefined ? { kind } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(displayAgent !== undefined ? { displayAgent } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(foregroundCwd !== undefined ? { foregroundCwd } : {}),
    ...(session !== undefined ? { agentSession: session } : {}),
    ...(a.agent_status !== undefined ? { status: a.agent_status } : {}),
    ...(a.revision !== undefined ? { revision: a.revision } : {}),
    ...(a.launch_pending !== undefined ? { launchPending: a.launch_pending } : {}),
    ...(a.interactive_ready !== undefined ? { interactiveReady: a.interactive_ready } : {}),
  };
}

/** A snapshot pane plus its agents-record entry (which wins over the pane-level agent fields). */
function paneOf(p: Raw, a: Raw | undefined): HerdrSnapshotPane {
  const cwd = str(p.cwd);
  const label = str(p.label);
  const terminalTitle = str(p.terminal_title_stripped);
  const tokens = tokensOf(p.tokens);
  // Pane-level agent fields (docs/runtime-kits.md 6.3): kept on the pane whether or not an agents
  // record exists, so a shell's status, name and cwd survive (`agentStatus`, `displayAgent`, `foregroundCwd`).
  const agentStatus = statusOf(p.agent_status);
  const displayAgent = str(p.display_agent);
  const foregroundCwd = str(p.foreground_cwd);
  const pane: HerdrSnapshotPane = {
    id: p.pane_id as string, focused: p.focused === true,
    ...(cwd === undefined ? {} : { cwd }),
    ...(label === undefined ? {} : { label }),
    ...(terminalTitle === undefined ? {} : { terminalTitle }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(agentStatus === undefined ? {} : { agentStatus }),
    ...(displayAgent === undefined ? {} : { displayAgent }),
    ...(foregroundCwd === undefined ? {} : { foregroundCwd }),
  };
  // Pane-level agent fields first, the agents record wins — mirrors the live merge below.
  if (a !== undefined) pane.agent = mergeAgent(mergeAgent(undefined, p), a);
  return pane;
}

/** A `pane.updated` payload merges in place: titles and labels with no re-bootstrap. */
function mergePane(pane: HerdrSnapshotPane, p: Raw): void {
  const cwd = str(p.cwd);
  if (cwd !== undefined) pane.cwd = cwd;
  const label = str(p.label);
  if (label !== undefined) pane.label = label;
  if (typeof p.focused === 'boolean') pane.focused = p.focused;
  const terminalTitle = str(p.terminal_title_stripped);
  if (terminalTitle !== undefined) pane.terminalTitle = terminalTitle;
  const agentStatus = statusOf(p.agent_status);
  if (agentStatus !== undefined) pane.agentStatus = agentStatus;
  const displayAgent = str(p.display_agent);
  if (displayAgent !== undefined) pane.displayAgent = displayAgent;
  const foregroundCwd = str(p.foreground_cwd);
  if (foregroundCwd !== undefined) pane.foregroundCwd = foregroundCwd;
  if (typeof p.tokens === 'object' && p.tokens !== null && !Array.isArray(p.tokens)) {
    const tokens = tokensOf(p.tokens);
    if (tokens === undefined) delete pane.tokens;
    else pane.tokens = tokens;
  }
}

function findPane(tree: HerdrSnapshot, paneId: string): HerdrSnapshotPane | undefined {
  for (const w of tree.workspaces) for (const t of w.tabs) {
    const found = t.panes.find((p) => p.id === paneId);
    if (found !== undefined) return found;
  }
  return undefined;
}

const editTarget = (op: string, o: HerdrTarget | undefined): 'pane' | 'tab' | 'workspace' => {
  const picked = (['pane', 'tab', 'workspace'] as const).filter((key) => o?.[key] !== undefined);
  if (picked.length !== 1) throw new Error(`herdr: ${op} picks exactly one of pane, tab or workspace`);
  return picked[0];
};

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
  private statusWatched = new Map<string, () => void>();   // pane id -> its per-pane status watch
  private generation = 0;
  private booting = false;                                 // a bootstrap is in flight
  private queued = false;                                  // one follow-up bootstrap is queued
  private buffered: HerdrEvent[] = [];                     // events held to replay after the next bootstrap
  private waiters: Waiter[] = [];                          // awaiting the in-flight bootstrap
  private nextWaiters: Waiter[] = [];                      // awaiting the queued follow-up bootstrap
  private statusEpoch = new Map<string, number>();   // lifecycle epochs per pane: a status push racing
                                                    // a snapshot read wins over the read (see bootstrap)
  private readonly o: HerdrKitOptions;
  private readonly callAny: Call = (method, params, timeoutMs) =>
    this.call(method as never, params as never, timeoutMs === undefined ? undefined : { timeoutMs });
  private readonly accountPanes: ReturnType<typeof createAccountPanes>;
  private readonly agents: ReturnType<typeof createAgents>;
  private readonly startListeners = new Set<(e: AgentStartEvent) => void>();
  private readonly blockedList: Blocked;
  private readonly turns: ReturnType<typeof createTurns>;
  constructor(o: HerdrKitOptions) {
    this.o = o;
    this.supervisor = new Supervisor(o, (s) => this.setState(s));
    this.accountPanes = createAccountPanes({ call: this.callAny, startAgent: (o) => this.startAgent(o),
      agentStatus: (kinds, options) => this.agentStatus(kinds, options) });
    this.agents = createAgents({ call: this.callAny, snapshot: () => this.snapshot(),
      reread: (paneId) => this.reread(paneId),
      launchEnv: () => o.mode === 'own' ? this.supervisor.env() : undefined,
      emitStart: (e) => { for (const fn of [...this.startListeners]) try { fn(e); } catch { /* a listener never breaks a start */ } } });
    this.blockedList = new Blocked({ call: this.callAny });
    this.turns = createTurns(this);
  }
  get state(): HerdrState { return this.current; }
  // `onState` hears a change of phase or why only (6.2): a re-read that lands where the kit already
  // is stays silent, so a host that re-reads on `ready` triggers no endless loop.
  private setState(s: HerdrState) {
    if (s.phase === this.current.phase && s.why === this.current.why) return;
    this.current = s; this.o.onState?.(s);
  }
  // Every tree change ends here: the revision rides the tree itself, so snapshot() always shows
  // the count and a wholesale tree swap carries it over.
  private publish() { this.tree.revision += 1; for (const fn of this.listeners) fn(this.snapshot()); }
  private emitRaw(e: HerdrEvent) { for (const fn of [...this.rawListeners]) fn(e); }
  // The kit's own watches report rejections here so the host keeps its invalid_subscription
  // logging without tapping the transport.
  private watchError(where: string): (code: string, message: string) => void {
    return (code, message) => this.o.onLog?.(`herdr: ${where} subscription rejected: ${code}: ${message}`);
  }
  private update(e: HerdrEvent) {
    const before = JSON.stringify(this.tree);
    const raw = e as Raw;
    // The pinned schema spells subscription kinds with dots (`pane.created`) while live
    // frames carry the underscore const (`pane_created`, schema/SOURCE.md); match both.
    const name = typeof e.type === 'string' ? e.type.replace(/_/g, '.') : '';
    const paneId = (raw.pane_id ?? raw.pane?.pane_id) as string | undefined;
    let owner: { workspaceId: string; tabId: string } | undefined;
    let pane: HerdrSnapshotPane | undefined;
    for (const w of this.tree.workspaces) {
      for (const t of w.tabs) {
        const found = t.panes.find((p) => p.id === paneId);
        if (found !== undefined) { pane = found; owner = { workspaceId: w.id, tabId: t.id }; }
      }
    }
    if (pane !== undefined && owner !== undefined &&
        (name === 'pane.agent.status.changed' || name === 'pane.agent.detected' || name === 'pane.updated')) {
      // `pane.updated` nests its record under `pane`; the status push is flat and its `agent` is
      // the kind string (PaneAgentStatusChangedEvent), never the record to merge.
      const a = typeof raw.pane === 'object' && raw.pane !== null ? raw.pane : raw;
      mergePane(pane, a);
      // Never conjure an agent for a plain shell: a `pane.updated` title tick carries no agent
      // identity, and a shell with no agents record must stay agentless (and unwatched).
      if (pane.agent !== undefined || namesAgent(a)) pane.agent = mergeAgent(pane.agent, a);
      // Every asserted status stamps the pane's lifecycle epoch — even an unchanged one, since a
      // racing snapshot read may carry a staler revision. The bootstrap below keeps the live push.
      if (a.agent_status !== undefined) {
        this.statusEpoch.set(paneId as string, (this.statusEpoch.get(paneId as string) ?? 0) + 1);
      }
      this.blockedList.update(paneId as string, pane.agent, owner);
      // A merge that names a real agent (`namesAgent`, the same gate as the merge above) on a pane
      // the last bootstrap saw as a plain shell opens that pane's watch now, so its status changes
      // reach the tree without waiting for the next structural event. A title-only `pane.updated` —
      // or any pane-level tick (`display_agent` alone) on a shell — names none of these and opens
      // nothing, so a shell stays agentless and unwatched.
      if (this.transport !== undefined && !this.statusWatched.has(paneId as string) && namesAgent(a)) {
        const ack = this.openStatusWatch(paneId as string);
        if (ack !== undefined) this.statusReadyPromise = this.statusReadyPromise.then(() => ack).then(() => undefined);
      }
    }
    if (name === 'pane.focused' && typeof paneId === 'string') {
      for (const w of this.tree.workspaces) for (const t of w.tabs) for (const p of t.panes) {
        p.focused = p.id === paneId;
      }
    }
    if (name === 'workspace.focused' && typeof raw.workspace_id === 'string') {
      for (const w of this.tree.workspaces) w.focused = w.id === raw.workspace_id;
    }
    if (name === 'workspace.updated') {
      // `workspace.updated` nests its record under `workspace` and merges in place, like
      // `pane.updated`: label/focused/number/tokens/worktree with no re-bootstrap.
      const record = typeof raw.workspace === 'object' && raw.workspace !== null ? raw.workspace as Raw : undefined;
      const workspace = this.tree.workspaces.find((w) => w.id === record?.workspace_id);
      if (workspace !== undefined && record !== undefined) {
        const label = str(record.label);
        if (label !== undefined) workspace.label = label;
        if (typeof record.focused === 'boolean') workspace.focused = record.focused;
        if (typeof record.number === 'number') workspace.number = record.number;
        if (typeof record.tokens === 'object' && record.tokens !== null && !Array.isArray(record.tokens)) {
          const tokens = tokensOf(record.tokens);
          if (tokens === undefined) delete workspace.tokens;
          else workspace.tokens = tokens;
        }
        if (record.worktree === undefined || record.worktree === null) delete workspace.worktree;
        else {
          const worktree = worktreeOf(record.worktree);
          if (worktree !== undefined) workspace.worktree = worktree;
        }
      }
    }
    if (name === 'pane.moved' && typeof raw.previous_pane_id === 'string') {
      // The move replaces the pane with a fresh id; the old id's lifecycle epoch must not
      // leak into a later pane that reuses it.
      this.statusEpoch.delete(raw.previous_pane_id);
    }
    if (name === 'pane.closed') {
      this.blockedList.update(paneId as string, undefined, owner ?? { workspaceId: '', tabId: '' });
      if (paneId !== undefined) this.statusEpoch.delete(paneId);
      for (const tab of this.tree.workspaces.flatMap((w) => w.tabs)) tab.panes = tab.panes.filter((p) => p.id !== paneId);
    }
    if (name === 'tab.closed') {
      for (const w of this.tree.workspaces) {
        const tab = w.tabs.find((t) => t.id === raw.tab_id);
        if (tab !== undefined) for (const p of tab.panes) this.statusEpoch.delete(p.id);
        w.tabs = w.tabs.filter((t) => t.id !== raw.tab_id);
      }
    }
    if (name === 'workspace.closed') {
      const workspace = this.tree.workspaces.find((w) => w.id === raw.workspace_id);
      if (workspace !== undefined) for (const t of workspace.tabs) for (const p of t.panes) this.statusEpoch.delete(p.id);
      this.tree.workspaces = this.tree.workspaces.filter((w) => w.id !== raw.workspace_id);
    }
    // `revision` moves only on a tree change: an event that leaves the tree as it was publishes nothing.
    // ponytail: the compare serialises the whole tree per event; per-branch changed flags if trees grow large.
    if (JSON.stringify(this.tree) !== before) this.publish();
  }
  private async bootstrap(token: number, buffered: HerdrEvent[]): Promise<void> {
    let resolveStatus!: () => void;
    const statusReady = new Promise<void>((resolve) => { resolveStatus = resolve; });
    this.statusReadyPromise = statusReady;
    this.statusReadyResolve = resolveStatus;
    const epochAtRead = new Map(this.statusEpoch);
    let result: Raw;
    try {
      result = await this.transport!.call('session.snapshot', {}) as Raw;
    } catch (error) {
      resolveStatus();
      throw error;
    }
    if (token !== this.generation) { resolveStatus(); return; }
    const snap = result.snapshot as Raw;
    // K11: the declared range gates the snapshot metadata too. Older than `min` fails closed;
    // newer than `max` installs the snapshot and stays usable with the steady state
    // `needs-update` instead of throwing, so a protocol bump never takes the host down.
    const { min, max } = protocolBounds(this.o.protocolRange);
    const seen = [result.protocol, snap?.protocol].filter((v): v is number => typeof v === 'number');
    if (seen.some((v) => v < min)) {
      this.setState({ phase: 'needs-update', why: 'version' });
      resolveStatus();
      throw new Error('herdr: snapshot protocol mismatch');
    }
    const newer = seen.some((v) => v > max);
    const workspaces: HerdrSnapshotWorkspace[] = (snap.workspaces as Raw[]).map((w) => {
      const tokens = tokensOf(w.tokens);
      const worktree = worktreeOf(w.worktree);
      return {
        id: w.workspace_id as string, label: w.label as string,
        focused: w.focused === true, number: typeof w.number === 'number' ? w.number : 0,
        ...(tokens === undefined ? {} : { tokens }),
        ...(worktree === undefined ? {} : { worktree }),
        tabs: (snap.tabs as Raw[]).filter((t) => t.workspace_id === w.workspace_id).map((t) => ({
          id: t.tab_id as string, label: t.label as string,
          panes: (snap.panes as Raw[]).filter((p) => p.tab_id === t.tab_id).map((p) =>
            paneOf(p, (snap.agents as Raw[]).find((a) => a.pane_id === p.pane_id))),
        })),
      };
    });
    for (const stop of this.statusStops) { stop(); this.stops.delete(stop); }
    this.statusStops.clear();
    this.statusWatched.clear();
    const previous = this.tree;
    this.tree = { connected: true, revision: previous.revision, workspaces };
    // Lifecycle-epoch guard: a per-pane status push that raced the snapshot read landed on the
    // previous tree (and stamped its epoch) while the read was in flight — the read predates it,
    // so the live status and revision win over the snapshot's.
    for (const w of this.tree.workspaces) for (const t of w.tabs) for (const p of t.panes) {
      if (p.agent === undefined) continue;
      if (epochAtRead.get(p.id) === this.statusEpoch.get(p.id)) continue;
      const live = findPane(previous, p.id)?.agent;
      if (live === undefined) continue;
      p.agent = { ...p.agent, status: live.status, revision: live.revision };
    }
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
      const ack = this.openStatusWatch(pane.id, token);
      if (ack !== undefined) statusAcks.push(ack);
    }
    void Promise.allSettled(statusAcks).then(() => { if (token === this.generation) resolveStatus(); });
    this.setState(newer ? { phase: 'needs-update', why: 'version' } : { phase: 'ready' });
  }
  // Re-read one agent and land its status, revision and launch flags: after a watch acks (a status
  // change before the ack reached no socket) and before `prompt` refuses (`launch_pending` rides
  // reads only, never a push). A push landing meanwhile is newer and wins status and revision (epoch
  // guard); the launch flags still land, since no push carries them.
  private async reread(paneId: string, token = this.generation): Promise<void> {
    const epoch = this.statusEpoch.get(paneId);
    let made: Raw | undefined;
    try { made = await this.transport?.call('agent.get', { target: paneId }) as Raw | undefined; } catch { return; }
    const agent = made?.agent;
    if (token !== this.generation || typeof agent?.agent_status !== 'string') return;
    // v0.9.1 leaves both flags out when false (`skip_serializing_if = is_false`): absent means false.
    const flags = { launch_pending: agent.launch_pending === true, interactive_ready: agent.interactive_ready === true };
    if (this.statusEpoch.get(paneId) !== epoch) {
      const pane = findPane(this.tree, paneId);
      if (pane?.agent !== undefined) {
        const before = JSON.stringify(this.tree);
        pane.agent = mergeAgent(pane.agent, flags);
        if (JSON.stringify(this.tree) !== before) this.publish();
      }
      return;
    }
    // The read's other fields may be staler than a merged pane.updated.
    this.update({ type: 'pane_agent_status_changed', pane_id: paneId, agent_status: agent.agent_status,
      ...(typeof agent.revision === 'number' ? { revision: agent.revision } : {}), ...flags } as HerdrEvent);
  }
  /**
   * Open one pane's own `pane.agent_status_changed` watch, recording it so the pane is never watched
   * twice. Returns the promise that settles when the watch acks (and re-reads the agent then), or
   * `undefined` when the pane is already watched or the transport has no ack promise.
   */
  private openStatusWatch(paneId: string, token = this.generation): Promise<unknown> | undefined {
    if (this.transport === undefined || this.statusWatched.has(paneId)) return undefined;
    const stop = this.transport.subscribe([{ type: 'pane.agent_status_changed', pane_id: paneId }],
      (e) => { this.emitRaw(e); this.update(e); }, this.watchError('status'));
    this.stops.add(stop);
    this.statusStops.add(stop);
    this.statusWatched.set(paneId, stop);
    const ready = (stop as typeof stop & { ready?: Promise<unknown> }).ready;
    if (ready === undefined) return undefined;
    return ready.then((ok) => (ok === false ? undefined : this.reread(paneId, token)));
  }
  /**
   * One bootstrap of the tree. Waits for the per-pane status watches to ack when `awaitStatus` is set.
   * A bootstrap that was asked for while another was running starts only after that one lands, so a
   * refresh always answers with a tree read after the caller's own change; at most one follow-up is
   * queued. Every `refresh()` waiter resolves when a bootstrap that started after its call lands; a
   * failed bootstrap rejects them with its own error.
   */
  private async runBootstrap(token: number, awaitStatus: boolean): Promise<void> {
    if (token !== this.generation) return;
    this.booting = true;
    let failure: unknown;
    let failed = false;
    try {
      await this.bootstrap(token, this.buffered);
      if (awaitStatus && token === this.generation) await this.statusWatchReady();
    } catch (error) {
      failure = error; failed = true;
    }
    // A `stop()` or a new `start()` since this bootstrap began owns the scheduler now: it already
    // reset these fields, so a stale run touches nothing (and its waiters were rejected there).
    if (token !== this.generation) return;
    this.booting = false;
    const landed = this.waiters; this.waiters = [];
    // A failure with no queued follow-up leaves the tree stale; the waiters hear the cause.
    if (failed) for (const waiter of landed) waiter.reject(failure);
    else for (const waiter of landed) waiter.resolve();
    if (this.queued) {
      this.queued = false;
      this.waiters = this.nextWaiters; this.nextWaiters = [];
      void this.runBootstrap(this.generation, true).catch(() => {});
    }
    if (failed) throw failure;
  }
  /** Ask for a re-bootstrap, coalescing with one already queued during a running bootstrap. */
  private queueBootstrap(): void {
    if (this.booting) { this.queued = true; return; }
    void this.runBootstrap(this.generation, true).catch(() => {});
  }
  /**
   * Connect and bootstrap. Non-fatal: a rejected `start()` (e.g. `failed/socket` while Herdr is
   * down) leaves the kit stopped, and `start()` may be called again afterwards — the host comes up
   * while Herdr is down by retrying `start()` in a backoff loop until it reaches `ready`.
   */
  async start(): Promise<void> {
    const token = ++this.generation;
    this.transport = await this.supervisor.start();
    this.buffered = [];
    this.booting = false;
    this.queued = false;
    this.waiters = [];
    this.nextWaiters = [];
    const stop = this.transport.subscribe(kinds.map((type) => ({ type })), (e) => {
      // Raw tap (K3): fire on arrival, before buffering/refresh/update, so listeners see every
      // wire payload (pane.moved.previous_pane_id, workspace.*) exactly once. Buffered replays
      // in bootstrap() call update() only and never re-emit.
      this.emitRaw(e);
      // Live frames carry the underscore spelling (`pane_created`); see update().
      const name = typeof e.type === 'string' ? e.type.replace(/_/g, '.') : '';
      const moves = structural(name);
      // A structural event during a bootstrap is buffered and queues one follow-up: the replay in
      // bootstrap() only merges, so the change lands in the tree from the next snapshot.
      if (this.booting || moves) {
        this.buffered.push(e);
        if (moves) this.queueBootstrap();
      } else this.update(e);
    }, this.watchError('events'));
    this.stops.add(stop);
    try {
      const control = stop as typeof stop & { ready?: Promise<boolean>; onReconnect?: (fn: () => void) => void;
        onDisconnect?: (fn: () => void) => void };
      control.onDisconnect?.(() => {
        if (token !== this.generation) return;
        this.setState({ phase: 'reconnecting' });
        this.tree.connected = false; this.publish();
      });
      control.onReconnect?.(() => { if (token === this.generation) this.queueBootstrap(); });
      if (await control.ready === false) throw new Error('herdr: event subscription rejected');
      await this.runBootstrap(token, false);
    } catch (error) {
      // The attempt owns this subscription: drop it so a retried `start()` dials clean.
      this.stops.delete(stop);
      stop();
      throw error;
    }
  }
  async stop(): Promise<void> {
    this.turns.stop();
    ++this.generation;
    this.statusReadyResolve?.();
    this.statusReadyPromise = Promise.resolve();
    this.statusReadyResolve = undefined;
    // A refresh still waiting on a bootstrap that will never land hears the kit is gone.
    const waiting = [...this.waiters, ...this.nextWaiters];
    this.waiters = []; this.nextWaiters = [];
    this.queued = false;
    this.buffered = [];
    this.booting = false;
    for (const waiter of waiting) waiter.reject(notConnected());
    for (const entry of this.blockedList.list()) this.blockedList.update(entry.paneId, undefined, entry);
    for (const stop of this.stops) stop(); this.stops.clear(); this.statusStops.clear();
    this.statusWatched.clear();
    this.statusEpoch.clear();
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
  subscribe<E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void,
    onError?: (code: string, message: string) => void): HerdrSubscribeStop {
    if (!this.transport) throw new Error('herdr: not connected');
    return this.transport.subscribe(subs, on as (e: HerdrEvent) => void, onError ?? (() => {}));
  }
  cli(args: string[], o?: { timeoutMs?: number; env?: Record<string, string> }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> { return runCli(this.o.bin, { ...this.supervisor.env(), ...o?.env }, args, o?.timeoutMs); }
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number; killGraceMs?: number }): TerminalSession { return openTerminal(this.o.bin, this.supervisor.env(), paneId, o); }
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
  /**
   * Re-read the tree and open watches for the agents in it, resolving once the fresh tree (and its
   * per-pane status watches) has landed. Call it after the app's own mutations to await a snapshot
   * that already carries them. Waiters arriving during a bootstrap resolve only on a bootstrap that
   * started after their call; a failed bootstrap rejects them with the failure. Rejects
   * `herdr: not connected` when the kit is not started.
   */
  refresh(): Promise<void> {
    if (this.transport === undefined) return Promise.reject(notConnected());
    return new Promise<void>((resolve, reject) => {
      if (this.booting) {
        this.queued = true;
        this.nextWaiters.push({ resolve, reject });
      } else {
        this.waiters.push({ resolve, reject });
        void this.runBootstrap(this.generation, true).catch(() => {});
      }
    });
  }
  openSignInTab(o: OpenSignInTab): Promise<AgentRef> { return this.accountPanes.openSignInTab(o); }
  move(o: Move): Promise<MoveResult> { return this.accountPanes.move(o); }
  moveToAccount(target: AgentRef, o: MoveToAccount): Promise<MoveToAccountResult> { return this.accountPanes.moveToAccount(target, o); }
  startAgent(o: StartAgent): Promise<AgentRef> { return this.agents.startAgent(o); }
  // Placement without an agent (6.4): the same ladder `startAgent` resolves — a shell or
  // application tab, a shell split, a new or labelled workspace — minus the launch. Creates the
  // pane and starts nothing; answers the placed pane/tab/workspace ref.
  place(o: PlaceRequest): Promise<PlaceRef> { return this.agents.place(o); }
  // App-wide start lifecycle without polling: every startAgent's installing/ready/launchFailed
  // lands here as well as on that call's own `onEvent`. Returns the unsubscribe function.
  onStartAgent(fn: (e: AgentStartEvent) => void): () => void {
    this.startListeners.add(fn);
    return () => { this.startListeners.delete(fn); };
  }
  prompt(target: AgentRef, text: string, o?: { wait?: { until?: AgentStatus[]; timeoutMs: number } }): Promise<PromptReceipt> { return this.agents.prompt(target, text, o); }
  waitPromptable(target: AgentRef, o: { timeoutMs: number }): Promise<void> { return this.agents.waitPromptable(target, o); }
  runTurn<T = unknown>(target: AgentRef, o: AgentTurnOptions<T>): Promise<AgentTurnEnd<T>> { return this.turns.runTurn(target, o); }
  onTurnEnd(fn: (end: AgentTurnEnd) => void): () => void { return this.turns.onTurnEnd(fn); }
  sendKeys(target: AgentRef, keys: string[]): Promise<void> { return this.agents.sendKeys(target, keys); }
  wait(target: AgentRef, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus> { return this.agents.wait(target, o); }
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number; ansi?: boolean }): Promise<{ text: string; truncated: boolean }> { return this.agents.read(paneId, o); }
  blocked(): BlockedAgent[] { return this.blockedList.list(); }
  onBlocked(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void { return this.blockedList.on(fn); }
  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void> { return this.blockedList.answer(paneId, keys, o); }
  closePane(paneId: string, o?: { confirmed?: { scope: 'tab'; id: string } }): Promise<void> { return closePane(this.callAny, paneId, o); }
  closeTab(tabId: string): Promise<void> { return closeTab(this.callAny, tabId); }
  closeWorkspace(workspaceId: string, o?: { confirmed?: { scope: 'worktreeGroup'; id: string } }): Promise<void> { return closeWorkspace(this.callAny, workspaceId, o); }
  // Typed edits (6.2): the one pane, tab or workspace maps to its generated Herdr method, so a Herdr
  // refusal rejects with Herdr's own code and sentence (`herdr: pane_not_found: pane w9:p9 not found`).
  async rename(o: HerdrRename): Promise<void> {
    const which = editTarget('rename', o);
    if (typeof o.label !== 'string' || o.label.length === 0) throw new Error('herdr: rename needs a label');
    if (which === 'pane') await this.call('pane.rename', { pane_id: o.pane!, label: o.label });
    else if (which === 'tab') await this.call('tab.rename', { tab_id: o.tab!, label: o.label });
    else await this.call('workspace.rename', { workspace_id: o.workspace!, label: o.label });
  }
  async focus(o: HerdrTarget): Promise<void> {
    const which = editTarget('focus', o);
    if (which === 'pane') await this.call('pane.focus', { pane_id: o.pane! });
    else if (which === 'tab') await this.call('tab.focus', { tab_id: o.tab! });
    else await this.call('workspace.focus', { workspace_id: o.workspace! });
  }
  // Every `layout.apply` option, passed through as given; Herdr picks the target when neither id is set.
  layout(o: HerdrLayout): Promise<HerdrResult<'layout.apply'>> {
    return this.call('layout.apply', {
      root: o.root,
      ...(o.focus === undefined ? {} : { focus: o.focus }),
      ...(o.tabId === undefined ? {} : { tab_id: o.tabId }),
      ...(o.workspaceId === undefined ? {} : { workspace_id: o.workspaceId }),
      ...(o.tabLabel === undefined ? {} : { tab_label: o.tabLabel }),
    });
  }
  agentKinds(): Promise<string[]> { return this.agents.agentKinds(); }
  installedAgentKinds(kinds: readonly string[], o: { path: string[]; aliases?: Record<string, string[]> }): string[] { return this.agents.installedAgentKinds(kinds, o); }
  // Onboarding readiness (B5): a local PATH probe plus each installed CLI's own status
  // command — no Herdr connection needed, credential files never read.
  agentStatus(kinds: readonly string[], o?: AgentStatusOptions): Promise<AgentReadiness[]> { return this.agents.agentStatus(kinds, o); }
}
