// Computers continue using the published Pi runtime, never the generated portable artifact.
import { createModels, createProvider } from '@earendil-works/pi-ai';
import type { ProviderStreams } from '@earendil-works/pi-ai';
import type { Platform } from './accounts.ts';
import type { KeyRuntime } from './key-routes.ts';

export type { KeyRuntime } from './key-routes.ts';

const loaders: Record<string, () => Promise<ProviderStreams>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai'),
  'mistral-conversations': () => import('@earendil-works/pi-ai/api/mistral-conversations'),
  'pi-messages': () => import('@earendil-works/pi-ai/api/pi-messages'),
  'azure-openai-responses': () => import('@earendil-works/pi-ai/api/azure-openai-responses'),
  'google-vertex': () => import('@earendil-works/pi-ai/api/google-vertex'),
};
export const runtime: KeyRuntime = { createModels, createProvider, supported: Object.keys(loaders),
  api: (name) => loaders[name](), cloudflare: () => import('@earendil-works/pi-ai/providers/cloudflare-stream') };
/** @byokit/accounts/keys on a computer: the same entry as on phones (`computer` already carries it). */
export const keys = async (): Promise<KeyRuntime> => runtime;
export const withKeys = (platform: Platform): Platform => ({ ...platform, keys });
