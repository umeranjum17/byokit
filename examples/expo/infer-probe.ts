import type { InitLlama, LlamaRnCompletionResult } from '@byokit/infer';

/** Own-lab only: the caller gates this observer and supplies fixed synthetic panes, never personal input. */
export function completionProbe(init: InitLlama, record: (entry: Record<string, unknown>) => Promise<void>): InitLlama {
  return async params => {
    const ctx = await init(params);
    const completion = ctx.completion.bind(ctx);
    ctx.completion = async (options, onToken) => {
      await record({ kind: 'request', options });
      const started = Date.now();
      const result = await completion(options, onToken);
      const native = result as LlamaRnCompletionResult & { timings?: unknown; chat_format?: number };
      await record({ kind: 'result', elapsedMs: Date.now() - started, text: native.text, content: native.content,
        adapterText: native.content || native.text, tokens_evaluated: native.tokens_evaluated, tokens_predicted: native.tokens_predicted,
        truncated: native.truncated, stopped_eos: native.stopped_eos, stopped_word: native.stopped_word,
        stopped_limit: native.stopped_limit, context_full: native.context_full, interrupted: native.interrupted,
        timings: native.timings, chat_format: native.chat_format });
      return result;
    };
    return ctx;
  };
}
