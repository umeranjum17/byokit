import catalogue from './models.json' with { type: 'json' };
import { checkModel } from './model.ts';
import { InferError, type InferModel } from './types.ts';
export * from './types.ts';
export { LocalModel, DEFAULT_LIMITS, modelName, type LocalModelOptions, type InitLlama, type LlamaRnContext, type LlamaRnContextParams,
  type LlamaRnCompletionParams, type LlamaRnCompletionResult, type LlamaRnMessage } from './model.ts';
export { generationBackend, type InferGenerationBackend } from './backend.ts';
export { summarizePane, paneText, plainText, redact, type PaneSummary, type PaneSummaryOptions } from './summary.ts';
export { WORDS, words, stateWords, errorWords, type WordKey } from './words.ts';

/** Pinned models, verified against the publisher's file metadata. `offer: false` entries are not yet qualified on a phone. */
export const MODELS: readonly InferModel[] = (catalogue as InferModel[]).map(checkModel);
/** Default candidate: official Qwen2.5 1.5B Instruct Q4_K_M, Apache-2.0, 1,117,320,736 bytes. */
export const DEFAULT_MODEL_ID = 'qwen2.5-1.5b-instruct-q4_k_m';
export function models(): InferModel[] { return MODELS.map(m => ({ ...m })); }
export function model(id: string = DEFAULT_MODEL_ID): InferModel {
  const m = MODELS.find(x => x.id === id);
  if (!m) throw new InferError('invalid', 'No pinned model has that id.', { detail: { id } });
  return { ...m };
}
