// Only loaded on the first key request. Published adapters, transformed for Metro by the kit with one recorded Hermes throwIfAborted guard.
import { createModels, createProvider } from './pi/core.js';
import type { ProviderStreams } from '@earendil-works/pi-ai';
import type { KeyRuntime } from './key-routes.ts';

const loaders: Record<string, () => Promise<ProviderStreams>> = {
  'openai-completions': () => import('./pi/openai-completions.js'),
  'openai-responses': () => import('./pi/openai-responses.js'),
  'anthropic-messages': () => import('./pi/anthropic-messages.js'),
  'google-generative-ai': () => import('./pi/google-generative-ai.js'),
  'mistral-conversations': () => import('./pi/mistral-conversations.js'),
  'pi-messages': () => import('./pi/pi-messages.js'),
  'azure-openai-responses': () => import('./pi/azure-openai-responses.js'),
};
export const runtime: KeyRuntime = { createModels, createProvider, supported: Object.keys(loaders),
  api: (name) => loaders[name](), cloudflare: () => import('./pi/cloudflare-stream.js') };
