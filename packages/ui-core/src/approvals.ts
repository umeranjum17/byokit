// What is waiting for a person's yes: the approvals list kept current from the kit's event stream, each dropped when
// it is answered anywhere or runs out of time. Framework-free; typed structurally against `@byokit/openclaw/device`.
import { retrying, store, type Stop, type Store } from './follow.ts';

/** One approval as the OpenClaw kit reports it. */
export type Approval = {
  id: string;
  source: 'gate' | 'exec' | 'plugin' | 'question';
  member: string;
  sessionKey?: string;
  tool?: string;
  summary: string;
  input?: unknown;
  at: number;
  /** When the computer stops waiting and says no by itself. */
  expires: number;
};
/** An `oc.events` frame: an approval added or resolved, or any other event (ignored here). */
export type ApprovalFrame = { event: string; change?: 'added' | 'resolved'; approval?: Approval };
export type ApprovalsAction = ApprovalFrame | { type: 'set'; list: Approval[] } | { type: 'tick'; now: number };

export function approvalsStep(list: Approval[], a: ApprovalsAction): Approval[] {
  if ('type' in a) {
    if (a.type === 'set') return a.list;
    const live = list.filter((x) => x.expires > a.now);
    return live.length === list.length ? list : live;
  }
  if (a.event !== 'approval' || !a.approval) return list;
  const { id } = a.approval;
  const rest = list.filter((x) => x.id !== id);
  if (a.change === 'resolved') return rest.length === list.length ? list : rest;
  if (a.change !== 'added') return list;
  const at = list.findIndex((x) => x.id === id);
  return at < 0 ? [...list, a.approval] : list.map((x, i) => (i === at ? a.approval! : x));
}

/** The question for one approval, in the kit's own sentence (`@byokit/openclaw/device`'s `words` fits). */
export const approvalWords = (a: Approval, words: (key: 'approval.ask', vars: { helper: string; summary: string }) => string,
  helper: string) => words('approval.ask', { helper, summary: a.summary });

/** What `approvalsStore` needs from a device client: `openclawDevice(link)` fits. */
export type ApprovalsSource = { approvals(): Promise<Approval[]>; events(): AsyncIterable<ApprovalFrame> };
export type FollowOptions = { retryMs?: number; now?: () => number };

/**
 * The approvals still waiting, live: listed once the event stream is open (so nothing falls between the two), then
 * added and resolved from its frames, and each dropped as it expires. Opened again after the link comes back.
 */
export function approvalsStore(source: ApprovalsSource, { retryMs = 2000, now = Date.now }: FollowOptions = {}): Store<Approval[]> {
  return store<Approval[]>([], (set) => {
    let list: Approval[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (a: ApprovalsAction) => {
      list = approvalsStep(approvalsStep(list, a), { type: 'tick', now: now() });
      clearTimeout(timer);
      if (list.length > 0) {
        const next = Math.min(...list.map((x) => x.expires)) - now();
        timer = setTimeout(() => apply({ type: 'tick', now: now() }), Math.min(Math.max(next, 0), 2 ** 31 - 1));
      }
      set(list);
    };
    const stop: Stop = retrying(async (live) => {
      const it = source.events()[Symbol.asyncIterator]();
      live.hold(it);
      try {
        const first = it.next(); // opens the stream before the list is read
        first.catch(() => {});
        const listed = await source.approvals();
        if (live.stopped()) return;
        apply({ type: 'set', list: listed });
        for (let r = await first; !r.done && !live.stopped(); r = await it.next()) apply(r.value);
      } finally {
        void it.return?.();
      }
    }, retryMs);
    return () => { stop(); clearTimeout(timer); };
  });
}
