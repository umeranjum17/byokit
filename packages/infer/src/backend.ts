import { InferError } from './types.ts';
import { modelName, type LocalModel } from './model.ts';
import { NanoModel } from './nano.ts';

/** Same shape as @byokit/decide's GenerationBackend (pinned by test/backend.test.ts); infer does not depend on decide.
 * Without `schema` the answer is free text and `data` is null. */
export type InferGenerationBackend = {
  name: string; model: string; leaves: false; supportsImages: false; cacheIdentity: string;
  generate(input: { system?: string; prompt: string; images?: readonly unknown[]; schema?: object; signal?: AbortSignal; maxOutputTokens?: number }):
    Promise<{ data: unknown | null; text: string; usage: { input_tokens: number; output_tokens: number } }>;
};
/** On this phone: Gemini Nano (`on-device-nano`) or the downloaded GGUF model (`on-device`). Never a subscription.
 * `local` is the full typed pass-through. */
export type InferLocalBackend = InferGenerationBackend & { billing: 'local'; local: LocalModel | NanoModel };
export type InferWhere = { where: 'local'; gguf: LocalModel; nano?: NanoModel };

/**
 * The one entry point: the caller picks where generation happens. `local` is Gemini Nano when AICore reports it ready
 * on this phone, else the GGUF model; decided here, once: a call never falls back between backends.
 */
export async function inferBackend(o: InferWhere): Promise<InferLocalBackend> {
  if (o?.where !== 'local') throw new TypeError('where must be local.');
  const phase = o.nano && (await o.nano.check()).phase;
  return generationBackend(o.nano && (phase === 'ready' || phase === 'busy') ? o.nano : o.gguf); // busy: Nano is answering another call
}

/**
 * decide's `generate()` over the phone's own model: `leaves: false`, so `privacy: 'stays-here'` keeps it. The GGUF
 * model's output is grammar-constrained to the schema; Nano is asked for it in words. A cut-off answer rejects
 * `incomplete` instead of returning partial data.
 */
export function generationBackend(local: LocalModel | NanoModel): InferLocalBackend {
  const nano = local instanceof NanoModel;
  return {
    name: nano ? 'on-device-nano' : 'on-device', leaves: false, supportsImages: false, billing: 'local', local,
    // Nano's id gains its base model name once AICore reports it, so cache keys follow model updates.
    get model() { return nano ? local.id : modelName(local.model); }, get cacheIdentity() { return nano ? local.id : local.model.sha256; },
    async generate(input) {
      if (input.images?.length) throw new InferError('unsupported', 'The on-device model reads text only.');
      const done = await local.complete({ system: input.system, prompt: input.prompt, jsonSchema: input.schema, signal: input.signal,
        maxOutputTokens: Math.min(input.maxOutputTokens ?? local.limits.maxOutputTokens, local.limits.maxOutputTokens) });
      if (done.stop === 'limit') throw new InferError('incomplete', 'The answer was cut off.');
      let data: unknown = null;
      try { if (input.schema) data = JSON.parse(done.text); } catch { /* decide reports invalid output. */ }
      return { data, text: done.text, usage: { input_tokens: done.inputTokens, output_tokens: done.outputTokens } };
    },
  };
}
