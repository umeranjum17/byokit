// Herdr's agents as a person sees them: the tree (where each agent is, and how it is doing) and the agents waiting
// for an answer, kept current from one `hd.events` stream. Framework-free; typed structurally against
// `@byokit/herdr/device`, so nothing here imports the kit.
import { retrying, store, type Store } from './follow.ts';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type HerdrAgent = {
  kind?: string; name?: string; status: AgentStatus; revision: number; launchPending?: boolean; interactiveReady?: boolean;
};
/** The tree as the Herdr kit reports it. */
export type HerdrTree = {
  connected: boolean;
  workspaces: { id: string; label: string; tabs: { id: string; label: string; panes: {
    id: string; cwd?: string; agent?: HerdrAgent;
  }[] }[] }[];
};
/** An agent waiting for an answer, as the Herdr kit reports it; `revision` goes back with the answer. */
export type BlockedAgent = {
  paneId: string; workspaceId: string; tabId: string; kind?: string; revision: number; prompt: string; since: number;
};
/** One `hd.events` frame. */
export type HerdrFrame =
  | { type: 'snapshot'; snapshot: HerdrTree }
  | { type: 'blocked'; change: 'added' | 'resolved'; blocked: BlockedAgent }
  | { type: 'raw'; line: string };
export type HerdrAction = HerdrFrame | { type: 'listed'; blocked: BlockedAgent[] };

/** `tree` is null until the computer first says what it has. */
export type HerdrState = { tree: HerdrTree | null; blocked: BlockedAgent[] };
export const HERDR_EMPTY: HerdrState = { tree: null, blocked: [] };

export function herdrStep(s: HerdrState, a: HerdrAction): HerdrState {
  if (a.type === 'snapshot') return { ...s, tree: a.snapshot };
  if (a.type === 'listed') return { ...s, blocked: a.blocked };
  if (a.type !== 'blocked') return s;
  const rest = s.blocked.filter((b) => b.paneId !== a.blocked.paneId);
  if (a.change === 'resolved') return rest.length === s.blocked.length ? s : { ...s, blocked: rest };
  const at = s.blocked.findIndex((b) => b.paneId === a.blocked.paneId);
  return { ...s, blocked: at < 0 ? [...s.blocked, a.blocked] : s.blocked.map((b, i) => (i === at ? a.blocked : b)) };
}

/** An agent as a list row: its status is what the kit's `agentWords` takes ('starting' while it launches). */
export type AgentRow = { paneId: string; name: string; kind?: string; status: AgentStatus | 'starting'; agent: HerdrAgent };

const row = (paneId: string, agent: HerdrAgent): AgentRow => ({
  paneId, name: agent.name ?? agent.kind ?? 'Agent', kind: agent.kind,
  status: agent.launchPending ? 'starting' : agent.status, agent,
});
// A workspace labelled with its folder reads as the folder's own name.
const place = (label: string) => label.split('/').filter(Boolean).pop() ?? label;

/** The agents grouped by where they run ("project · tab"), tabs without an agent left out. */
export function herdrTreeView(tree: HerdrTree | null) {
  return (tree?.workspaces ?? []).flatMap((w) => w.tabs.map((t) => ({
    workspaceId: w.id, tabId: t.id, where: `${place(w.label)} · ${t.label}`,
    agents: t.panes.flatMap((p) => (p.agent ? [row(p.id, p.agent)] : [])),
  }))).filter((g) => g.agents.length > 0);
}

/** The agent in one pane, if that pane has one. */
export function agentIn(tree: HerdrTree | null, paneId: string | undefined): AgentRow | undefined {
  for (const w of tree?.workspaces ?? []) for (const t of w.tabs) for (const p of t.panes) {
    if (p.id === paneId) return p.agent ? row(p.id, p.agent) : undefined;
  }
  return undefined;
}

/** The waiting agents, each with the name to show for it. */
export const blockedView = (s: HerdrState) =>
  s.blocked.map((b) => ({ ...b, name: agentIn(s.tree, b.paneId)?.name ?? b.kind ?? 'Agent' }));

/** What `herdrStore` needs from a device client: `herdrDevice(link)` fits. */
export type HerdrSource = { blocked(): Promise<BlockedAgent[]>; events(): AsyncIterable<HerdrFrame> };

const shared = new WeakMap<HerdrSource, Store<HerdrState>>();

/**
 * The tree and the waiting agents, live from one `hd.events` stream per device however many views watch it: the
 * tree from its frames, the waiting list read once the stream is open and then kept by its frames. Opened again
 * after the link comes back.
 */
export function herdrStore(source: HerdrSource, { retryMs = 2000 }: { retryMs?: number } = {}): Store<HerdrState> {
  const known = shared.get(source);
  if (known) return known;
  const made = store<HerdrState>(HERDR_EMPTY, (set) => {
    let s = made.get();
    const apply = (a: HerdrAction) => set(s = herdrStep(s, a));
    return retrying(async (live) => {
      const it = source.events()[Symbol.asyncIterator]();
      live.hold(it);
      try {
        const first = it.next(); // the first frame is the tree, sent once the stream is open
        first.catch(() => {});
        const listed = await source.blocked();
        const r = await first;
        if (r.done || live.stopped()) return;
        apply(r.value);
        apply({ type: 'listed', blocked: listed });
        for (let r = await it.next(); !r.done && !live.stopped(); r = await it.next()) apply(r.value);
      } finally {
        void it.return?.();
      }
    }, retryMs);
  });
  shared.set(source, made);
  return made;
}
