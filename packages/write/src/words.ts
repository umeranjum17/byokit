// Every sentence a person can see, in one file other languages can read too (words.json, docs/capability-kits.md
// 4.8). Plain words only, and no claim about where a draft goes (D-P).
import WORDS from './words.json' with { type: 'json' };
import type { ComposeError } from './errors.ts';
import type { DraftCheck, Platform } from './types.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled; an unfilled slot stays visible. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const ERROR_KEY: Record<ComposeError['code'], WordKey> = {
  missing: 'compose.missing', 'needs-update': 'compose.needsUpdate', engine: 'compose.failed', invalid: 'compose.failed',
};

/** The sentence for a rejection. */
export const errorWords = (e: ComposeError): string => words(ERROR_KEY[e.code]);

/** A draft passes when it fits, breaks no voice rule, keeps every fact and keeps the layout (4.6). */
export function draftPasses(c: DraftCheck, o?: { original?: boolean }): boolean {
  if (!c.fits || c.voice.length > 0) return false;
  if (o?.original === true && (c.added.length > 0 || c.dropped.length > 0 || !c.layoutKept)) return false;
  return true;
}

/** The plain lines for one checked draft, in the 4.8 order. */
export function checkLines(c: DraftCheck, platform: Platform, o?: { original?: boolean }): string[] {
  const lines: string[] = [];
  if (c.fits || c.limit === null) {
    lines.push(words('check.fits', { platform: platform.label }));
  } else {
    lines.push(words('check.tooLong', { platform: platform.label, length: String(c.length), limit: String(c.limit) }));
  }
  if (c.voice.length > 0) lines.push(words('check.voice', { list: c.voice.join(', ') }));
  if (c.stock.length > 0) lines.push(words('check.stock', { list: c.stock.join(', ') }));
  if (o?.original === true) {
    if (c.added.length > 0) lines.push(words('check.added', { list: c.added.join(', ') }));
    if (c.dropped.length > 0) lines.push(words('check.dropped', { list: c.dropped.join(', ') }));
    if (c.added.length === 0 && c.dropped.length === 0) lines.push(words('check.keptFacts', {}));
    if (!c.layoutKept) lines.push(words('check.layout', {}));
  }
  lines.push(words(draftPasses(c, o) ? 'check.pass' : 'check.fail', {}));
  return lines;
}
