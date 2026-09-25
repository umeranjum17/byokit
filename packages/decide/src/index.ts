// Typed questions in, a typed answer with confidence out, abstaining below a floor. The floor, the per-option floors,
// the runner-up and the tie are code, never a prompt: ported from firstmate's bin/fm-dispatch-resolve.sh.
export { jev } from './jev.ts';

export type Question =
  /** Pick one option; `floors` holds an option's own floor, checked against that option's probability. */
  | { kind: 'choice'; options: Record<string, string>; instructions?: string; floor?: number; floors?: Record<string, number> }
  | { kind: 'yesno'; question: string; yes?: string; no?: string; floor?: number }
  /** An ordered rubric, lowest first. The answer is the most probable level's index. */
  | { kind: 'score'; levels: string[]; instructions?: string; floor?: number };

export type Answer = {
  /** null when abstained: the app takes its safe default (ask a person). */
  answer: string | boolean | number | null;
  confidence: number;
  probabilities?: Record<string, number>;
  abstained: boolean;
  /** Why it abstained, or which runner-up it fell to. For logs, not for people. */
  reason?: string;
  by: string;
  ms: number;
};

/** A backend's answer before the floors: every option's probability, keyed as options (choice), 'true'/'false'
 * (yesno) or level indexes (score). A missing or malformed one is an abstain. */
export type Raw = { probabilities: Record<string, number>; confidence?: number; pick?: string };

export type Backend = {
  name: string;
  /** Whether the state leaves this device. Such a backend is skipped for `privacy: 'stays-here'`. */
  leaves: boolean;
  ask(state: unknown, questions: Record<string, Question>, signal: AbortSignal): Promise<Record<string, Raw | undefined>>;
};

export type Options = { privacy: 'stays-here' | 'may-leave'; backends: Backend[]; timeoutMs?: number };

export const FLOOR = 0.6;

/** Asks each backend in order for the questions still unanswered; a failed or slow backend answers nothing. */
export async function decide(state: unknown, questions: Record<string, Question>, opts: Options): Promise<Record<string, Answer>> {
  const out: Record<string, Answer> = {};
  const open = () => Object.fromEntries(Object.entries(questions).filter(([k]) => !out[k] || out[k].abstained));
  for (const b of opts.backends) {
    if (b.leaves && opts.privacy !== 'may-leave') continue;
    const todo = open();
    if (!Object.keys(todo).length) break;
    const t0 = Date.now();
    let raws: Record<string, Raw | undefined> = {};
    let failed = '';
    try {
      raws = await b.ask(state, todo, AbortSignal.timeout(opts.timeoutMs ?? 5000));
    } catch (e) {
      failed = `${b.name} failed: ${(e as Error).message}`;
    }
    const ms = Date.now() - t0;
    for (const [k, q] of Object.entries(todo)) {
      const a = { ...resolve(q, raws[k]), by: b.name, ms };
      if (!raws[k] && failed) a.reason = failed;
      if (!out[k] || !a.abstained || a.probabilities) out[k] = a;
    }
  }
  for (const k of Object.keys(questions)) out[k] ??= { answer: null, confidence: 0, abstained: true, reason: 'no backend answered', by: 'none', ms: 0 };
  return out;
}

/** The floors on one raw answer. Exported for apps that hold a recorded answer. */
export function resolve(q: Question, raw: Raw | undefined): Omit<Answer, 'by' | 'ms'> {
  const keys = q.kind === 'choice' ? Object.keys(q.options) : q.kind === 'yesno' ? ['true', 'false'] : q.levels.map((_, i) => String(i));
  const p = raw?.probabilities;
  const ok = p && Object.keys(p).length === keys.length && keys.every((k) => typeof p[k] === 'number' && p[k] >= 0 && p[k] <= 1)
    && Math.abs(keys.reduce((s, k) => s + p[k], 0) - 1) <= 0.01
    && (raw.confidence === undefined || (raw.confidence >= 0 && raw.confidence <= 1))
    && (raw.pick === undefined || keys.includes(raw.pick));
  if (!ok) return { answer: null, confidence: 0, abstained: true, reason: raw ? 'malformed answer' : 'no answer' };
  const ranked = [...keys].sort((a, b) => p[b] - p[a]);
  const picked = raw.pick ?? ranked[0];
  const confidence = raw.confidence ?? p[picked];
  const floor = q.floor ?? FLOOR;
  const own = (k: string) => (q.kind === 'choice' ? q.floors?.[k] : undefined) ?? floor;
  const typed = (k: string) => (q.kind === 'choice' ? k : q.kind === 'yesno' ? k === 'true' : Number(k));
  const done = (k: string, reason?: string) => ({ answer: typed(k), confidence, probabilities: p, abstained: false, ...(reason && { reason }) });
  const abstain = (reason: string) => ({ answer: null, confidence, probabilities: p, abstained: true, reason });
  if (p[ranked[0]] === p[ranked[1]]) return abstain('tie');
  // Without a declared floor on the pick, the one floor applies to the answer's confidence, exactly as firstmate's.
  if (!(q.kind === 'choice' && q.floors && picked in q.floors)) return confidence >= floor ? done(picked) : abstain(`confidence ${confidence} below floor ${floor}`);
  if (p[picked] >= own(picked)) return done(picked);
  // A runner-up never needs weaker support than it would as the pick: it must clear its own floor.
  const clear = ranked.filter((k) => k !== picked && p[k] >= own(k));
  if (!clear.length) return abstain(`${picked} probability ${p[picked]} below its floor ${own(picked)}; no other option clears its own`);
  if (clear.length > 1 && p[clear[0]] === p[clear[1]]) return abstain('runner-up tie');
  return done(clear[0], `fell to ${clear[0]}: ${picked} probability ${p[picked]} below its floor ${own(picked)}`);
}

/** The app's own function as a backend: return the answer when the case is obvious, undefined otherwise. Stays here. */
export function rules(fn: (state: any, name: string, q: Question) => string | boolean | number | undefined): Backend {
  return {
    name: 'rules',
    leaves: false,
    async ask(state, questions) {
      const out: Record<string, Raw | undefined> = {};
      for (const [k, q] of Object.entries(questions)) {
        const a = fn(state, k, q);
        if (a === undefined) continue;
        const keys = q.kind === 'choice' ? Object.keys(q.options) : q.kind === 'yesno' ? ['true', 'false'] : q.levels.map((_, i) => String(i));
        out[k] = { probabilities: Object.fromEntries(keys.map((o) => [o, o === String(a) ? 1 : 0])) };
      }
      return out;
    },
  };
}
