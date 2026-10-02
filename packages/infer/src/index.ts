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
/** The first model: SmolLM2 360M Instruct, Q8_0 GGUF, Apache-2.0, 386,404,992 bytes. */
export const DEFAULT_MODEL_ID = 'smollm2-360m-instruct-q8_0';
export function models(): InferModel[] { return MODELS.map(m => ({ ...m })); }
export function model(id: string = DEFAULT_MODEL_ID): InferModel {
  const m = MODELS.find(x => x.id === id);
  if (!m) throw new InferError('invalid', 'No pinned model has that id.', { detail: { id } });
  return { ...m };
}
