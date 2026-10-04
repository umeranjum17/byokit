import { InferError } from './types.ts';
import { modelName, type LocalModel } from './model.ts';

/** Same shape as @byokit/decide's GenerationBackend (pinned by test/backend.test.ts); infer does not depend on decide. */
export type InferGenerationBackend = {
  name: string; model: string; leaves: false; supportsImages: false; cacheIdentity: string;
  generate(input: { system?: string; prompt: string; images?: readonly unknown[]; schema: object; signal?: AbortSignal; maxOutputTokens?: number }):
    Promise<{ data: unknown | null; text: string; usage: { input_tokens: number; output_tokens: number } }>;
};

/**
 * decide's `generate()` over the phone's own model: `leaves: false`, so `privacy: 'stays-here'` keeps it. Output is
 * grammar-constrained to the schema; a cut-off answer rejects `incomplete` instead of returning partial data.
 */
export function generationBackend(local: LocalModel): InferGenerationBackend {
  return {
    name: 'on-device', model: modelName(local.model), leaves: false, supportsImages: false, cacheIdentity: local.model.sha256,
    async generate(input) {
      if (input.images?.length) throw new InferError('unsupported', 'The on-device model reads text only.');
      const done = await local.complete({ system: input.system, prompt: input.prompt, jsonSchema: input.schema, signal: input.signal,
        maxOutputTokens: Math.min(input.maxOutputTokens ?? local.limits.maxOutputTokens, local.limits.maxOutputTokens) });
      if (done.stop === 'limit') throw new InferError('incomplete', 'The answer was cut off.');
      let data: unknown = null;
      try { data = JSON.parse(done.text); } catch { /* decide reports invalid output. */ }
      return { data, text: done.text, usage: { input_tokens: done.inputTokens, output_tokens: done.outputTokens } };
    },
  };
}
