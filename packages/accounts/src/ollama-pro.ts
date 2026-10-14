import type { Keystore } from '@byokit/secrets';
import {
  deleteOpenCodePlanKey, openCodePlanKeyEntry, readOpenCodePlanKey, saveOpenCodePlanKey,
} from './opencode-go.ts';

/** An Ollama Pro plan account (route `ollama-pro:plan_key`). `access` reads the saved plan key from
 * the caller's store. Never falls back to API billing. */
export type OllamaProAccount = {
  readonly billing: 'subscription';
  readonly provider: 'ollama-pro';
  access(signal: AbortSignal): Promise<string>;
};

/** One @byokit/secrets entry per route (same seam as OpenCode Go). */
export const OLLAMA_PRO_PLAN_ROUTE = 'ollama-pro:plan_key';
/** Hosted OpenAI-compatible base URL: https://docs.ollama.com/api/openai-compatibility */
export const OLLAMA_PRO_BASE_URL = 'https://ollama.com/v1';
/** Default cloud model: https://ollama.com/library/deepseek-v4.1-flash:cloud */
export const OLLAMA_PRO_DEFAULT_MODEL = 'deepseek-v4.1-flash';

export const ollamaProPlanKeyEntry = (route: string = OLLAMA_PRO_PLAN_ROUTE): string => openCodePlanKeyEntry(route);
export async function saveOllamaProPlanKey(store: Keystore, key: string, route: string = OLLAMA_PRO_PLAN_ROUTE): Promise<void> {
  await saveOpenCodePlanKey(store, key, route);
}
export async function readOllamaProPlanKey(store: Keystore | undefined, route: string = OLLAMA_PRO_PLAN_ROUTE): Promise<string> {
  return readOpenCodePlanKey(store, route, 'Ollama Pro');
}
export async function deleteOllamaProPlanKey(store: Keystore | undefined, route: string = OLLAMA_PRO_PLAN_ROUTE): Promise<void> {
  await deleteOpenCodePlanKey(store, route);
}
export function ollamaProPlanAccount(store: Keystore, route: string = OLLAMA_PRO_PLAN_ROUTE): OllamaProAccount {
  return { billing: 'subscription', provider: 'ollama-pro', access: async () => readOllamaProPlanKey(store, route) };
}

/** One non-streaming chat turn on Ollama Cloud. Plan key from the store only — never argv/env. */
export async function ollamaProChat(opts: {
  store: Keystore; prompt: string; model?: string; baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal; route?: string;
}): Promise<string> {
  if (typeof opts.prompt !== 'string' || !opts.prompt.trim()) throw new Error('ollamaProChat needs a prompt');
  const key = await readOllamaProPlanKey(opts.store, opts.route);
  const base = (opts.baseUrl ?? OLLAMA_PRO_BASE_URL).replace(/\/$/, '');
  const res = await (opts.fetch ?? globalThis.fetch)(`${base}/chat/completions`, {
    method: 'POST', signal: opts.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: opts.model ?? OLLAMA_PRO_DEFAULT_MODEL, messages: [{ role: 'user', content: opts.prompt }], stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama Pro request failed (http ${res.status}).`);
  const json = await res.json() as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('Ollama Pro returned no text.');
  if (text.includes(key)) throw new Error('Ollama Pro returned unexpected content.');
  return text;
}
