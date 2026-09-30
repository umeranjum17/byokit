import WORDS from './words.json' with { type: 'json' };
import type { Code } from './types.ts';
export { WORDS };
export type WordKey = keyof typeof WORDS;
export const words = (key: WordKey, vars: Record<string, string> = {}): string => WORDS[key].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
export const usageWords = (code: Code, vars: { name: string }): string => words(`code.${code}`, vars);
