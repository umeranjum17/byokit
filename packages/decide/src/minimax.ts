// MiniMax models used for decisions, not a dedicated decision model. Probabilities are self-reported.
// Endpoint and wire format come from the @byokit/accounts route `minimax:key` (api `anthropic-messages`, base URL
// https://api.minimax.io/anthropic): the Anthropic Messages shape with one forced `decisions` tool, the member's
// MiniMax API key as `x-api-key`. API key only (billed per use by MiniMax): there is no plan sign-in here and no
// fallback between billing routes. The model is the host's explicit choice, read from the vendor's own live list.
import type { Backend } from './core.ts';
import { messagesBackend, type AnthropicOptions } from './anthropic.ts';

export type MiniMaxOptions = AnthropicOptions;

export const MINIMAX_ROUTES = {
  apiKey: { billing: 'api', offer: false },
} as const;

const BASE = 'https://api.minimax.io/anthropic/v1';

/** One explicitly supplied MiniMax API key. API-billed; never a plan sign-in. */
export function minimax(o: MiniMaxOptions): Backend {
  return messagesBackend('minimax', BASE, o);
}
