// An eval file is JSONL: a header line `{ decision, question, note? }`, then one labelled case per line,
// `{ state, expect, jev?, ms? }`. `expect` is the right answer, a list of right answers, or null when only an abstain is
// right. `jev` is Jev's answer to replay offline (CI never calls a model); a live run with --record refreshes it.
import { resolve, type Answer, type Question } from './index.ts';
import { raw } from './jev.ts';

export type Case = { state: unknown; expect: string | boolean | number | null | Array<string | boolean | number>; jev?: unknown; ms?: number };
/** `note` says where the recorded answers came from. */
export type EvalFile = { decision: string; question: Question; note?: string; cases: Case[] };
export type Report = {
  cases: number; agree: number; abstained: number;
  /** Answered, and not a right answer: the number that must stay near 0. */
  clearWrong: number;
  ms: { min: number; median: number; max: number };
  wrong: Array<{ line: number; expect: Case['expect']; got: Answer['answer']; confidence: number }>;
};

export function parse(text: string): EvalFile {
  const [head, ...rest] = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (!head?.decision || !head.question) throw new Error('the first line needs decision and question');
  return { ...head, cases: rest };
}

export function format(f: EvalFile): string {
  const { cases, ...head } = f;
  return [head, ...cases].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** Scores `ask` over the cases, in order. */
export async function evaluate(cases: Case[], ask: (c: Case) => Promise<Answer>): Promise<Report> {
  const r: Report = { cases: cases.length, agree: 0, abstained: 0, clearWrong: 0, ms: { min: 0, median: 0, max: 0 }, wrong: [] };
  const ms: number[] = [];
  for (const [i, c] of cases.entries()) {
    const a = await ask(c);
    ms.push(a.ms);
    const right = c.expect === null ? [] : Array.isArray(c.expect) ? c.expect : [c.expect];
    if (a.abstained) r.abstained++;
    else if (right.includes(a.answer as never)) r.agree++;
    else r.clearWrong++, r.wrong.push({ line: i + 2, expect: c.expect, got: a.answer, confidence: a.confidence });
  }
  ms.sort((a, b) => a - b);
  if (ms.length) r.ms = { min: ms[0], median: ms[Math.floor((ms.length - 1) / 2)], max: ms[ms.length - 1] };
  return r;
}

/** Jev's recorded answer through the same floors a live answer takes. */
export function replay(q: Question): (c: Case) => Promise<Answer> {
  return async (c) => ({ ...resolve(q, raw(q, c.jev)), by: 'jev (recorded)', ms: c.ms ?? 0 });
}

export function summary(name: string, by: string, r: Report): string {
  const pct = (n: number) => `${r.cases ? Math.round((n / r.cases) * 100) : 0}%`;
  return [
    `${name} (${by}): ${r.cases} cases`,
    `  agree ${r.agree}/${r.cases}   clear-but-wrong ${r.clearWrong} (${pct(r.clearWrong)})   abstained ${r.abstained} (${pct(r.abstained)})   ms min/median/max ${r.ms.min}/${r.ms.median}/${r.ms.max}`,
    ...r.wrong.map((w) => `  wrong: line ${w.line} expected ${JSON.stringify(w.expect)}, got ${JSON.stringify(w.got)} at ${w.confidence}`),
  ].join('\n');
}
