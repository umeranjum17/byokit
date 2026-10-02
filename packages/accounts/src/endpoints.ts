import type { Model, Models } from '@earendil-works/pi-ai';
import type { Billing, Readiness } from './catalogue.ts';

export type EndpointCompat = 'openai' | 'anthropic';
export type EndpointBilling = Exclude<Billing, 'free'>;
/** Request tuning is Pi's own model shape; auth, headers and destinations belong to the selected account. */
export type EndpointModel = Omit<Model<'openai-completions' | 'anthropic-messages'>, 'api' | 'provider' | 'baseUrl' | 'headers'>;
export type EndpointConfig = {
  baseUrl: string; compat: EndpointCompat; billing: EndpointBilling; name?: string;
  models?: readonly EndpointModel[];
};
export type EndpointOptions = EndpointConfig & { key?: string };
export type EndpointRecord = EndpointConfig & { hasKey: boolean; active: boolean };
/** A host driver uses the pinned Pi adapters, never a global provider registry. */
export type EndpointDriver = (id: string, config: EndpointConfig, auth: () => Promise<string | undefined>) => Models;
export type EndpointPreset = 'ollama' | 'llama.cpp' | 'vllm' | 'lmstudio' | 'sglang';
export const ENDPOINT_PRESETS: Readonly<Record<EndpointPreset, EndpointConfig>> = {
  ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', compat: 'openai', billing: 'local' },
  'llama.cpp': { name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', compat: 'openai', billing: 'local' },
  vllm: { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', compat: 'openai', billing: 'local' },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', compat: 'openai', billing: 'local' },
  sglang: { name: 'SGLang', baseUrl: 'http://127.0.0.1:30000/v1', compat: 'openai', billing: 'local' },
};
export class EndpointError extends Error {
  readonly readiness: Exclude<Readiness, 'ready'> | 'signed_out';
  constructor(readiness: Exclude<Readiness, 'ready'> | 'signed_out') {
    super(readiness === 'needs_host' ? 'This endpoint needs the app’s host side.' : 'This endpoint is not available.');
    this.name = 'EndpointError';
    this.readiness = readiness;
  }
}
/** Billing is a required choice. URLs cannot hide credentials in userinfo, query or fragment. */
export function endpointConfig(input: EndpointConfig): EndpointConfig {
  let url: URL;
  try { url = new URL(input.baseUrl); } catch { throw new Error('Enter an HTTP or HTTPS endpoint URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS endpoint URL without credentials, query or fragment.');
  if (!['local', 'api', 'subscription', 'unknown'].includes(input.billing)) throw new Error('Choose this endpoint’s billing explicitly.');
  if (!['openai', 'anthropic'].includes(input.compat)) throw new Error('Choose OpenAI or Anthropic compatibility.');
  // Copy only public model fields; never persist caller-supplied headers/auth or another account's destination.
  if (input.models && (!Array.isArray(input.models) || input.models.some((m) => !m || typeof m.id !== 'string' || !m.id.trim() || typeof m.name !== 'string' || typeof m.reasoning !== 'boolean' || !Array.isArray(m.input) || m.input.some((i) => !['text', 'image'].includes(i)) || !m.cost || !Number.isFinite(m.contextWindow) || m.contextWindow <= 0 || !Number.isFinite(m.maxTokens) || m.maxTokens <= 0))) throw new Error('Give this endpoint valid Pi model definitions.');
  const models = input.models?.map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, input: [...m.input], cost: { ...m.cost },
    contextWindow: m.contextWindow, maxTokens: m.maxTokens, ...(m.compat ? { compat: { ...m.compat } } : {}),
    ...(m.thinkingLevelMap ? { thinkingLevelMap: { ...m.thinkingLevelMap } } : {}),
    ...(m.inputLimits ? { inputLimits: m.inputLimits } : {}), ...(m.promptCache ? { promptCache: m.promptCache } : {}),
    ...(m.samplingParams ? { samplingParams: { ...m.samplingParams } } : {}) }));
  return { baseUrl: url.href.replace(/\/$/, ''), compat: input.compat, billing: input.billing,
    ...(input.name ? { name: input.name } : {}), ...(models ? { models } : {}) };
}
export function endpointLabel(billing: EndpointBilling): string {
  return { local: 'Runs on this computer', api: 'Charged per use to your endpoint account', subscription: 'Uses your endpoint plan', unknown: 'Billing set by your endpoint' }[billing];
}
export function endpointNeedsHost(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host.startsWith('127.') || host === '0.0.0.0';
}
