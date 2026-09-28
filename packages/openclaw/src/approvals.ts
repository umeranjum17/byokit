// Native approvals: exec.approval.*, plugin.approval.* and question.* surfaced through the same Approval shape (5.9, O5).
import { randomBytes } from 'node:crypto';
import type { Bridge } from './bridge.ts';
import type { Approval, Decision, GatewayTransport, Member } from './types.ts';

type NativeSource = 'exec' | 'plugin' | 'question';

type Stored = Approval & { native?: { source: NativeSource; id: string } };

const strip = (a: Stored): Approval => {
  const { native, ...approval } = a;
  void native;
  return approval;
};

const REQUESTED: Record<string, NativeSource> = {
  'exec.approval.requested': 'exec',
  'plugin.approval.requested': 'plugin',
  'question.requested': 'question',
};
const RESOLVED = new Set(['exec.approval.resolved', 'plugin.approval.resolved', 'question.resolved']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

const memberOfKey = (key: string): Member | undefined => {
  const m = /^agent:([a-z][a-z0-9-]{0,31}):/.exec(key);
  return m?.[1];
};

/** Member attribution: the payload's agent first, else the `agent:<member>:` session key (5.9). */
function attribute(payload: Record<string, unknown>): { member: Member; sessionKey?: string } {
  const agent = asString(payload.agentId);
  const key = asString(payload.sessionKey);
  const fromKey = key ? memberOfKey(key) : undefined;
  const member = agent ?? fromKey ?? asString(payload.member) ?? 'unknown';
  return { member, ...(key ? { sessionKey: key } : {}) };
}

function summaryOf(source: NativeSource, payload: Record<string, unknown>): string {
  const ask = asString(payload.ask);
  if (ask) return ask;
  const command = asString(payload.command);
  if (command) return `run ${command}`;
  const questions = payload.questions;
  if (Array.isArray(questions)) {
    const first = questions.map((q) => (isRecord(q) ? asString(q.question) ?? asString(q.header) : undefined)).find(Boolean);
    if (first) return first;
  }
  const title = asString(payload.title);
  if (title) return title;
  return source === 'question' ? 'answer a question' : 'approve an action';
}

function expiresOf(payload: Record<string, unknown>, fallbackMs: number): number {
  const at = typeof payload.expiresAtMs === 'number' ? payload.expiresAtMs : Date.now() + fallbackMs;
  return at;
}

export class Approvals {
  private readonly request: GatewayTransport['request'];
  private readonly bridge: Pick<Bridge, 'resolveAsk'>;
  private readonly approvals = new Map<string, Stored>();
  private readonly listeners = new Set<(a: Approval, change: 'added' | 'resolved') => void>();

  constructor(o: { request: GatewayTransport['request']; bridge: Pick<Bridge, 'resolveAsk'> }) {
    this.request = o.request;
    this.bridge = o.bridge;
  }

  handleEvent(e: { event: string; payload?: unknown }): void {
    const payload = isRecord(e.payload) ? e.payload : {};
    const source = REQUESTED[e.event];
    if (source) {
      const id = asString(payload.id) ?? randomBytes(12).toString('base64url');
      if (this.approvals.has(id)) return;
      const { member, sessionKey } = attribute(payload);
      const now = Date.now();
      const approval: Stored = {
        id,
        source,
        member,
        ...(sessionKey ? { sessionKey } : {}),
        ...(asString(payload.tool) ? { tool: payload.tool as string } : {}),
        summary: summaryOf(source, payload),
        ...('questions' in payload ? { input: payload.questions } : {}),
        at: typeof payload.createdAtMs === 'number' ? payload.createdAtMs : now,
        expires: expiresOf(payload, 180_000),
        native: { source, id },
      };
      this.approvals.set(id, approval);
      this.emit(approval, 'added');
      return;
    }
    if (RESOLVED.has(e.event)) {
      const id = asString(payload.id);
      if (id) this.remove(id);
    }
  }

  add(a: Approval): void {
    if (this.approvals.has(a.id)) return;
    this.approvals.set(a.id, a);
    this.emit(a, 'added');
  }

  remove(id: string): void {
    const a = this.approvals.get(id);
    if (!a) return;
    this.approvals.delete(id);
    this.emit(strip(a), 'resolved');
  }

  list(member?: Member): Approval[] {
    const all = [...this.approvals.values()].map(strip);
    return member === undefined ? all : all.filter((a) => a.member === member);
  }

  on(fn: (a: Approval, change: 'added' | 'resolved') => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async decide(id: string, d: Decision): Promise<void> {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`unknown approval: ${id}`);
    if (a.source === 'gate') {
      if (!this.bridge.resolveAsk(id, d)) throw new Error(`unknown approval: ${id}`);
      return;
    }
    const native = a.native;
    if (!native) throw new Error(`unknown approval: ${id}`);
    if (native.source === 'exec' || native.source === 'plugin') {
      const method = native.source === 'exec' ? 'exec.approval.resolve' : 'plugin.approval.resolve';
      await this.request(method, { id: native.id, decision: d.allow ? 'allow-once' : 'deny' });
      return;
    }
    if (d.allow) {
      await this.request('question.resolve', { id: native.id, answers: this.answersFor(a, d.answer) });
    } else {
      await this.request('question.resolve', { id: native.id, cancel: true });
    }
  }

  private answersFor(a: Approval, answer: unknown): unknown {
    if (isRecord(answer) && 'answers' in answer) return answer;
    const questions = Array.isArray(a.input) ? a.input : [];
    const ids = questions.filter(isRecord).map((q) => asString(q.questionId)).filter(Boolean) as string[];
    if (ids.length === 1 && Array.isArray(answer)) return { answers: { [ids[0]]: answer } };
    throw new Error('a question approval needs answers for its questions');
  }

  private emit(a: Approval, change: 'added' | 'resolved'): void {
    for (const fn of this.listeners) fn(a, change);
  }
}
