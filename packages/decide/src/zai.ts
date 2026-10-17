// Z.AI (GLM) coding-plan models used for decisions, not a dedicated decision model. Probabilities are self-reported.
// Endpoints and wire format come from the pinned upstream (`@earendil-works/pi-ai`, providers `zai` and `zai-coding-cn`,
// api `openai-completions`) that the @byokit/accounts routes `zai:plan_key` and `zai:plan_key:zai-coding-cn` name: the
// chat-completions shape with a strict json_schema, the member's coding-plan key as Bearer. Plan only: the key is passed
// directly or read from a plan account; there is no API-billed route and no fallback between key inputs.
import { UnsupportedAccountError } from './account-error.ts';
import type { Backend, Question, Raw } from './core.ts';
import { httpError, parseUsage, retryFetch, type RetryOptions } from './http.ts';
import { isJsonRecord, parsedAnswers, responsesInstructions, responsesSchema } from './responses-wire.ts';

export { UnsupportedAccountError } from './account-error.ts';

export type ZaiRoute = 'zai' | 'zai-coding-cn';
/** A Z.AI plan handle. Its provider tag names the route, so a plan handle only reaches its own endpoint. */
export type ZaiAccount = {
  readonly billing: 'subscription';
  readonly provider: ZaiRoute;
  access(signal: AbortSignal): Promise<string>;
};
/** Either the member's Z.AI plan key itself (with `route`, default `zai`), or a plan account whose tag names the route. Never both. */
export type ZaiOptions = RetryOptions & {
  model: string;
  route?: ZaiRoute;
  fetch?: typeof fetch;
  request?: { instructions?: string };
} & ({ key: string; account?: never } | { account: ZaiAccount; key?: never });

export const ZAI_ROUTES = {
  apiKey: { billing: 'subscription', offer: false },
  account: { billing: 'subscription', offer: true, consentRequired: true },
} as const;

const BASE: Record<ZaiRoute, string> = {
  zai: 'https://api.z.ai/api/coding/paas/v4',
  'zai-coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4',
};

/** One Z.AI coding-plan key, passed directly or through the member's plan account. Never falls back to API billing. */
export function zai(o: ZaiOptions): Backend {
  if (typeof o.model !== 'string' || !o.model.trim()) throw new Error('zai needs an explicit model');
  const account = o.account;
  if (account !== undefined) {
    if (o.key !== undefined) throw new Error('zai takes a plan key or a plan account, not both');
    if (!account || account.billing !== 'subscription' || typeof account.access !== 'function') {
      throw new UnsupportedAccountError('Z.AI plan usage needs a Z.AI plan account from the @byokit/accounts peer.');
    }
    const tag: unknown = (account as { provider?: unknown }).provider;
    if (typeof tag !== 'string' || !Object.hasOwn(BASE, tag)) {
      throw new UnsupportedAccountError(tag === undefined
        ? 'Z.AI plan usage needs a Z.AI plan account; update @byokit/accounts if this account has no provider tag.'
        : `This is a ${String(tag)} plan account; pass it on the ${String(tag)} route.`);
    }
    if (o.route !== undefined && o.route !== tag) throw new Error('zai route must match the plan account');
  } else if (typeof o.key !== 'string' || !o.key.trim()) {
    throw new Error('zai needs a key');
  }
  const route: ZaiRoute = account ? account.provider : (o.route ?? 'zai');
  if (!Object.hasOwn(BASE, route)) throw new Error('zai route must be zai or zai-coding-cn');
  const request = o.request ?? {};
  const send = retryFetch('zai', o.fetch ?? globalThis.fetch, o);
  return {
    name: 'zai', leaves: true, supportsImages: false,
    async ask(state, questions, signal) {
      const token = account ? await account.access(signal) : (o.key as string);
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
      const body = {
        model: o.model,
        messages: [
          { role: 'system', content: responsesInstructions(questions, request.instructions) },
          { role: 'user', content: JSON.stringify({ state, questions }) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'decisions', strict: true, schema: responsesSchema(questions) } },
      };
      const res = await send(`${BASE[route]}/chat/completions`, { method: 'POST', signal, headers, body: JSON.stringify(body) });
      if (!res.ok) {
        // A refusal (401/402/403) abstains with its code on the key and the account alike.
        if (account && [400, 404].includes(res.status)) {
          throw new UnsupportedAccountError(`Z.AI plan request unsupported (http ${res.status}).`);
        }
        throw httpError(res.status);
      }
      const json: unknown = await res.json();
      return chatAnswers(questions, json);
    },
  };
}

/** One chat-completions choice's JSON text, parsed only when the model finished. A cut-off, refused or malformed
 * reply abstains, keeping usage and the raw response, as the Responses wire does. */
function chatAnswers(questions: Record<string, Question>, json: unknown): Record<string, Raw> {
  const usage = parseUsage(isJsonRecord(json) && isJsonRecord(json.usage)
    ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens } : undefined);
  const choice = isJsonRecord(json) && Array.isArray(json.choices) ? json.choices[0] : undefined;
  let parsed: unknown;
  if (isJsonRecord(choice) && choice.finish_reason === 'stop' && isJsonRecord(choice.message) && typeof choice.message.content === 'string') {
    try { parsed = JSON.parse(choice.message.content); } catch { /* malformed text abstains, carrying the response */ }
  }
  return parsedAnswers(questions, parsed, usage, json);
}
