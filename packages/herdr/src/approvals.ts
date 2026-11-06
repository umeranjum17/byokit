// Blocked-agent approvals (docs/runtime-kits.md 6.4, D10): a `blocked` agent is a question; the
// answer is keys to that exact pane occupant, refused as `approval-stale` when the question has
// moved on. The prompt text is the pane's `detection` read — the kit never interprets the agent's TUI.
//
// The question is named twice, because the pane revision alone does not name it: the pinned Herdr
// 0.9.1 reported the same revision for four consecutive Cursor questions (measured in the H9 lab),
// so a revision-only check would type the last question's keys into the next one's dialog. Each
// published question therefore carries a kit-issued revision, and the question text the caller was
// shown (its last lines, where every approval dialog sits) catches a question that changed while the
// pane stayed `blocked`: that answer is refused and the live question is published under a new one.
import type { Call } from './agents.ts';
import type { BlockedAgent, HerdrSnapshot } from './types.ts';

type Raw = Record<string, any>;
type AgentRecord = NonNullable<HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number]['agent']>;

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

// The lines that name a question: every approval dialog sits at the bottom of the pane, and the last
// eight non-empty lines carry its command and its options (a Cursor dialog is seven). A dialog that
// rewrites itself inside that window would read as a new question; the refusal then re-lists the
// live question, so the next answer lands.
const QUESTION_LINES = 8;
const questionOf = (text: string): string =>
  text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').slice(-QUESTION_LINES).join('\n');

export class Blocked {
  private readonly call: Call;
  private readonly entries = new Map<string, BlockedAgent>();
  private readonly questions = new Map<string, string>();   // the question each entry answers
  private serial = 0;   // the identity a caller answers with, named by the kit: Herdr's pane revision
                        // does not move between two questions on one pane (H9 measured four Cursor
                        // dialogs at one revision), so only a value the kit issues names the question.
  private readonly listeners = new Set<(b: BlockedAgent, change: 'added' | 'resolved') => void>();
  private readonly reading = new Set<string>();   // detection reads in flight, one per pane
  private readonly wanted = new Set<string>();    // panes still blocked while their read is in flight

  constructor(ctx: { call: Call }) { this.call = ctx.call; }

  update(paneId: string, agent: AgentRecord | undefined, where: { workspaceId: string; tabId: string }): void {
    if (agent?.status !== 'blocked') {
      this.wanted.delete(paneId);
      this.questions.delete(paneId);
      const entry = this.entries.get(paneId);
      if (entry !== undefined) {
        this.entries.delete(paneId);
        for (const fn of this.listeners) fn(entry, 'resolved');
      }
      return;
    }
    // Still blocked: the listed question keeps its identity until `answer` finds it changed.
    if (this.entries.has(paneId)) return;
    if (this.reading.has(paneId)) { this.wanted.add(paneId); return; }
    this.wanted.add(paneId);
    this.reading.add(paneId);
    const pending: BlockedAgent = {
      paneId, workspaceId: where.workspaceId, tabId: where.tabId,
      ...(agent.kind === undefined ? {} : { kind: agent.kind }),
      revision: 0, prompt: '', since: Date.now(),
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
    const entry: BlockedAgent = { ...pending, revision: ++this.serial, prompt };
    this.entries.set(pending.paneId, entry);
    this.questions.set(pending.paneId, questionOf(prompt));
    for (const fn of this.listeners) fn(entry, 'added');
  }

  // A question that changed under an unchanged revision: the listed one is replaced, so the app's
  // next answer speaks to the dialog that is actually open.
  private republish(paneId: string, prompt: string): void {
    this.questions.set(paneId, questionOf(prompt));
    const was = this.entries.get(paneId);
    if (was === undefined) return;
    const entry = { ...was, revision: ++this.serial, prompt, since: Date.now() };
    this.entries.set(paneId, entry);
    for (const fn of this.listeners) { fn(was, 'resolved'); fn(entry, 'added'); }
  }

  list(): BlockedAgent[] { return [...this.entries.values()]; }

  on(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  async answer(paneId: string, keys: string[], o: { revision: number }): Promise<void> {
    const entry = this.entries.get(paneId);
    let blocked = entry !== undefined;
    try {
      const made = (await this.call('pane.get', { pane_id: paneId })) as Raw;
      blocked = made?.pane?.agent_status === 'blocked';
    } catch { /* gone or unreachable: the listed question decides, as it did before */ }
    if (!blocked || entry === undefined || o.revision !== entry.revision) {
      throw fail('approval-stale', 'That answer is out of date; the question has changed.');
    }
    const asked = this.questions.get(paneId);
    if (asked !== undefined) {
      let live: string | undefined;
      try {
        const made = (await this.call('pane.read', { pane_id: paneId, source: 'detection', lines: 40 })) as Raw;
        if (typeof made?.read?.text === 'string') live = made.read.text;
      } catch { /* a read that fails leaves the recorded question deciding, like the revision fallback */ }
      if (live !== undefined && questionOf(live) !== asked) {
        this.republish(paneId, live);
        throw fail('approval-stale', 'That answer is out of date; the question has changed.');
      }
    }
    await this.call('agent.send_keys', { target: paneId, keys });
  }
}
