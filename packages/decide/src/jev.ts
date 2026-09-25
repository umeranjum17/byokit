// Jev, TypeSafe's decision model, over its own API or OpenRouter's copy of it (the same request and answers).
// The key is the host's: the app reads it from its own environment or config and hands it here. The kit never reads
// an environment variable, never ships a key and never puts it anywhere but the one request header.
import type { Backend, Question, Raw } from './index.ts';

const BASE = { typesafe: 'https://api.typesafe.ai', openrouter: 'https://openrouter.ai/api' };

export function jev(opts: { key: string; via?: 'typesafe' | 'openrouter'; model?: string; fetch?: typeof fetch }): Backend {
  const { key, via = 'typesafe', model = 'jev-latest', fetch: f = globalThis.fetch } = opts;
  if (!key) throw new Error('jev needs a key');
  return {
    name: 'jev',
    leaves: true,
    async ask(state, questions, signal) {
      const res = await f(`${BASE[via]}/v1/systemone`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, state, questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, wire(q)])) }),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const answers = ((await res.json()) as { answers?: Record<string, unknown> })?.answers ?? {};
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, raw(q, answers[k])]));
    },
  };
}

function wire(q: Question) {
  if (q.kind === 'choice') return { type: 'choice', instructions: q.instructions ?? 'Which option fits the state?', criteria: q.options };
  if (q.kind === 'yesno') return { type: 'noul', instructions: q.question, ...(q.yes && q.no && { criteria: { true: q.yes, false: q.no } }) };
  return { type: 'score', instructions: q.instructions ?? 'Where does the state fall on this scale?', criteria: q.levels };
}

/** Jev's answer as a Raw; anything off-shape is undefined, which the floors treat as an abstain. */
export function raw(q: Question, a: any): Raw | undefined {
  if (!a || typeof a !== 'object') return undefined;
  if (q.kind === 'yesno') return typeof a.noul === 'number' ? { probabilities: { true: a.noul, false: 1 - a.noul } } : undefined;
  if (typeof a.probabilities !== 'object' || typeof a.confidence !== 'number') return undefined;
  if (q.kind === 'choice') return typeof a.choice === 'string' ? { probabilities: a.probabilities, confidence: a.confidence, pick: a.choice } : undefined;
  return { probabilities: a.probabilities, confidence: a.confidence };
}
