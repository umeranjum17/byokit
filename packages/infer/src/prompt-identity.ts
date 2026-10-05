/**
 * Prompt identity for cache-hit analysis: a content hash plus the engine's input token count.
 * A hash plus a token count answers "identical or not" and nothing more: the hash is one-way,
 * and no prompt, pane or user text is ever stored or logged beside it.
 * Portable: string arithmetic only, so the React Native bundle stays free of Node imports.
 */

/** 64-bit cyrb53 of the exact prompt bytes, as 16 hex chars. Identical text always hashes identically. */
export function promptHash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** What one `summarizePane` prompt was: the engine's token count plus the hash. Never any content. */
export type PromptIdentity = { inputTokens: number; hash: string };

/** Two prompts are identical only when both the token count and the hash match. */
export const samePromptIdentity = (a: PromptIdentity, b: PromptIdentity): boolean =>
  a.inputTokens === b.inputTokens && a.hash === b.hash;

/** Bench-readable counters. The first prompt of a session counts as `changed`: there is nothing it could repeat. */
export type PromptIdentityCounts = {
  total: number;
  consecutiveIdentical: number;
  identicalNonConsecutive: number;
  changed: number;
};

/**
 * Counts exact repeats against changed prompts. A later device session feeds every
 * `summarizePane` identity here; `counts` (plain JSON) is what its bench script reads.
 */
export class PromptIdentityLog {
  #last: PromptIdentity | undefined;
  #seen = new Set<string>();
  #counts: PromptIdentityCounts = { total: 0, consecutiveIdentical: 0, identicalNonConsecutive: 0, changed: 0 };

  record(id: PromptIdentity): PromptIdentityCounts {
    const key = `${id.inputTokens}:${id.hash}`;
    this.#counts.total++;
    if (this.#last !== undefined && samePromptIdentity(this.#last, id)) this.#counts.consecutiveIdentical++;
    else if (this.#seen.has(key)) this.#counts.identicalNonConsecutive++;
    else this.#counts.changed++;
    this.#seen.add(key);
    this.#last = id;
    return this.counts;
  }

  get counts(): PromptIdentityCounts { return { ...this.#counts }; }

  reset(): void {
    this.#last = undefined;
    this.#seen.clear();
    this.#counts = { total: 0, consecutiveIdentical: 0, identicalNonConsecutive: 0, changed: 0 };
  }
}

/**
 * Length of the shared leading characters of two prompt texts: the upper bound of what a
 * stateful KV cache could reuse without re-ingesting. Whether llama.rn reuses a shared
 * prefix across *different* prompts is unmeasured (bench5 proved only the identical case);
 * this only quantifies how much prefix consecutive pane prompts share.
 */
export const commonPrefixLength = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};
