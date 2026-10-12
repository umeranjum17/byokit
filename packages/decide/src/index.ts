// Typed questions in, a typed answer with confidence out, abstaining below a floor. Rules, Jev and configurable OpenAI backends, and an eval runner.
export { generate, generationCacheKey, MemoryGenerationCache, type GenerationInput, type GenerationRequest, type GenerationBackend, type GenerationResult, type GenerationCache, type GenerationOptions, type GenerationBudget, type Generated } from './generate.ts';
export { InvalidSchemaError, type OutputSchema, type SchemaOutput } from './schema.ts';
export { resolve, rules, answerer, cacheKey, MemoryCache, FLOOR, RateLimitError,
  UnsupportedAccountError, UnsupportedImagesError, InvalidImageError,
  type Question, type QuestionOptions, type Answer, type Usage, type Raw, type Backend, type Options,
  type DecideCache, type RuleAnswer, type AnswererReply, type AnswererRequestOptions, type AnswererOptions,
  type AnswererBackend, type RetryOptions, type ImageInput, type DecisionImage } from './core.ts';
// Typed questions in, a typed answer with confidence out, abstaining below a floor. The floor, the per-option floors,
// the runner-up and the tie are code, never a prompt: ported from firstmate's bin/fm-dispatch-resolve.sh.
export { jev } from './jev.ts';
export { pairedJev, jevHost, PAIRED_JEV_OP, type PairedJevLink, type JevHostKeys } from './paired.ts';
export { PairedHostError, type PairedHostProblem } from './paired-errors.ts';
export { openai, OPENAI_ROUTES, type OpenAIAccount, type OpenAIOptions, type OpenAIRequestOptions } from './openai.ts';
export { parseConfig, createDecider, ConfigError, type DecideConfig, type ConfigHost, type ConfigOptions } from './config.ts';
import { decide as decideCore } from './core.ts';
import { decideForConfig, type ConfigOptions } from './config.ts';
import type { Answer, Options, Question } from './core.ts';

/** Asks each backend in order for the questions still unanswered; a failed or slow backend answers nothing.
 * A `{ config, host }` call resolves its one configured backend first (Jev or OpenAI); a `{ backends }`
 * call asks the given backends directly. */
export async function decide(state: unknown, questions: Record<string, Question>, opts: Options | ConfigOptions): Promise<Record<string, Answer>> {
  return 'config' in opts ? decideForConfig(state, questions, opts) : decideCore(state, questions, opts);
}
