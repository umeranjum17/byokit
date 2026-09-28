// Blocked-agent approvals (docs/runtime-kits.md 6.4, D10): a `blocked` agent is a question; the
// answer is keys to that exact pane occupant, refused as `approval-stale` when the question has
// moved on (the pane's revision). The prompt text is the pane's `detection` read — the kit never
// interprets the agent's TUI.
import type { Call } from './agents.ts';
import type { BlockedAgent, HerdrSnapshot } from './types.ts';

type Raw = Record<string, any>;
type AgentRecord = NonNullable<HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number]['agent']>;

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export class Blocked {
  private readonly call: Call;
  private readonly entries = new Map<string, BlockedAgent>();
  private readonly listeners = new Set<(b: BlockedAgent, change: 'added' | 'resolved') => void>();
  private readonly reading = new Set<string>();   // detection reads in flight, one per pane
  private readonly wanted = new Set<string>();    // panes still blocked while their read is in flight

  constructor(ctx: { call: Call }) { this.call = ctx.call; }

  update(paneId: string, agent: AgentRecord | undefined, where: { workspaceId: string; tabId: string }): void {
    if (agent?.status !== 'blocked') {
      this.wanted.delete(paneId);
      const entry = this.entries.get(paneId);
      if (entry !== undefined) {
        this.entries.delete(paneId);
        for (const fn of this.listeners) fn(entry, 'resolved');
      }
      return;
    }
    const current = this.entries.get(paneId);
    if (current !== undefined) {
      // Still blocked: keep the question, follow the pane's revision.
      if (agent.revision !== current.revision) this.entries.set(paneId, { ...current, revision: agent.revision });
      return;
    }
    if (this.reading.has(paneId)) { this.wanted.add(paneId); return; }
    this.wanted.add(paneId);
    this.reading.add(paneId);
    const pending: BlockedAgent = {
      paneId, workspaceId: where.workspaceId, tabId: where.tabId,
      ...(agent.kind === undefined ? {} : { kind: agent.kind }),
      revision: agent.revision, prompt: '', since: Date.now(),
    };
    void this.readPrompt(pending);
  }

  // The entry only appears once its prompt text is known, so `list()` never shows a half-read question.
  private async readPrompt(pending: BlockedAgent): Promise<void> {
    let prompt = '';
    try {
      const made = (await this.call('pane.read', { pane_id: pending.paneId, source: 'detection', lines: 40 })) as Raw;
      if (typeof made?.read?.text === 'string') prompt = made.read.text;
    } catch { /* a failed read still lists the blocked agent, with the text it could get */ }
    this.reading.delete(pending.paneId);
    if (!this.wanted.delete(pending.paneId)) return;   // the pane left `blocked` while the read ran
    const entry: BlockedAgent = { ...pending, prompt };
    this.entries.set(pending.paneId, entry);
    for (const fn of this.listeners) fn(entry, 'added');
  }

  list(): BlockedAgent[] { return [...this.entries.values()]; }

  on(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  async answer(paneId: string, keys: string[], o: { revision: number }): Promise<void> {
    let status: unknown;
    let current: number | undefined;
    try {
      const made = (await this.call('pane.get', { pane_id: paneId })) as Raw;
      status = made?.pane?.agent_status;
      // The pinned schema carries the pane's revision on pane.get; a server without it falls back
      // to the revision recorded when the question appeared.
      if (typeof made?.pane?.revision === 'number') current = made.pane.revision;
    } catch { /* gone or unreachable: the recorded revision decides below */ }
    if (current === undefined) current = this.entries.get(paneId)?.revision;
    if (status !== 'blocked' || current === undefined || o.revision !== current) {
      throw fail('approval-stale', 'That answer is out of date; the question has changed.');
    }
    await this.call('agent.send_keys', { target: paneId, keys });
  }
}
