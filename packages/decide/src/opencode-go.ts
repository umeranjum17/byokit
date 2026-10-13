// OpenCode Go plan models used for decisions, not a dedicated decision model. Probabilities are self-reported.
// Endpoint and wire format come from the @byokit/accounts route `opencode:plan_key:opencode-go` and its pinned
// upstream (`@earendil-works/pi-ai`, provider `opencode-go`): the OpenAI Responses shape at
// https://opencode.ai/zen/go/v1, billed with the member's plan key as Bearer. Plan only: the key is the
// captain's plan key whether passed directly or read from the member's saved account; there is no
// API-billed route and no fallback between key inputs.
import type { OpenCodeGoAccount } from '@byokit/accounts/opencode-go';
import { UnsupportedAccountError } from './account-error.ts';
import type { Backend } from './core.ts';
import { normalizeImages, validateImageReferences, UnsupportedImagesError } from './images.ts';
import { retryFetch, type RetryOptions } from './http.ts';
import { responsesAnswers, responsesInput, responsesInstructions, responsesSchema } from './responses-wire.ts';
import type { OpenAIRequestOptions } from './openai.ts';

export { UnsupportedAccountError } from './account-error.ts';
export type { OpenCodeGoAccount };
export type OpenCodeGoOptions = RetryOptions & {
  model: string;
  /** Either the member's OpenCode Go plan key itself, or the plan account from the
   * @byokit/accounts peer (`accounts.opencodeGo(member)`) that reads it. Never both. */
  fetch?: typeof fetch;
  request?: OpenAIRequestOptions;
  /** Host declares the selected model supports vision; absent means text only. */
  supportsImages?: boolean;
} & ({ key: string; account?: never } | { account: OpenCodeGoAccount; key?: never });

export const OPENCODE_GO_ROUTES = {
  apiKey: { billing: 'subscription', offer: false },
  account: { billing: 'subscription', offer: true, consentRequired: true },
} as const;

const BASE = 'https://opencode.ai/zen/go/v1';

/** One OpenCode Go plan key, passed directly or through the member's plan account. Never falls back to API billing. */
export function opencodeGo(o: OpenCodeGoOptions): Backend {
  if (typeof o.model !== 'string' || !o.model.trim()) throw new Error('opencodeGo needs an explicit model');
  if (typeof o.key === 'string') {
    if (!o.key.trim()) throw new Error('opencodeGo needs a key');
    if (o.account !== undefined) throw new Error('opencodeGo takes a plan key or a plan account, not both');
  } else if (o.key !== undefined) {
    throw new Error('opencodeGo needs a key');
  } else if (!o.account || o.account.billing !== 'subscription' || typeof o.account.access !== 'function') {
    throw new UnsupportedAccountError('OpenCode Go plan usage needs an OpenCode Go plan account from the @byokit/accounts peer (install it and use accounts.opencodeGo(member)).');
  } else if ((o.account as { provider?: unknown }).provider !== 'opencode-go') {
    const tag = (o.account as { provider?: unknown }).provider;
    throw new UnsupportedAccountError(tag === undefined
      ? 'OpenCode Go plan usage needs an OpenCode Go plan account; update @byokit/accounts if this account has no provider tag.'
      : `This is a ${String(tag)} plan account; pass it on the ${String(tag)} route.`);
  }
  const request = o.request ?? {};
  const send = retryFetch('opencode-go', o.fetch ?? globalThis.fetch, o);
  return {
    name: 'opencode-go', leaves: true, supportsImages: o.supportsImages === true,
    async ask(state, questions, signal, inputImages = []) {
      const images = normalizeImages(inputImages);
      validateImageReferences(questions, images);
      if (images.length && !o.supportsImages) throw new UnsupportedImagesError(o.model);
      const instructions = responsesInstructions(questions, request.instructions as string | undefined);
      const input = responsesInput(state, questions, images);
      const text = { ...request.text, format: { type: 'json_schema' as const, name: 'decisions', strict: true, schema: responsesSchema(questions) } };
      const token = typeof o.key === 'string' ? o.key : await o.account.access(signal);
      // The Go endpoint routes on a per-conversation session id (pinned upstream maps its
      // `sessionId` option to this header and omits it only when the caller has none; Go rejects
      // the request without it). One decide call is one conversation; retries keep its id.
      const sessionId = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-opencode-session': sessionId };
      const body = { ...request, model: o.model, instructions, input, text };
      const res = await send(`${BASE}/responses`, { method: 'POST', signal, headers, body: JSON.stringify(body) });
      if (!res.ok) {
        if ([400, 401, 403, 404].includes(res.status)) {
          throw new UnsupportedAccountError(`OpenCode Go plan request unsupported (http ${res.status}).`);
        }
        throw new Error(`http ${res.status}`);
      }
      const json: unknown = await res.json();
      return responsesAnswers(questions, json);
    },
  };
}
