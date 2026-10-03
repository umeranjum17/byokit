import type { InitLlama, LlamaRnCompletionResult } from '@byokit/infer';

/** Own-lab only: the caller gates this observer and supplies fixed synthetic panes, never personal input. */
/** On-screen raw receipts require both explicit lab opt-in and a development build. */
export const completionReceiptText = (probe: boolean, development: boolean, text: string): string => probe && development ? text : '';

export function completionProbe(init: InitLlama, record: (entry: Record<string, unknown>) => Promise<void>): InitLlama {
  return async params => {
    const ctx = await init(params);
    const completion = ctx.completion.bind(ctx);
    ctx.completion = async (options, onToken) => {
      await record({ kind: 'request', options });
      const started = Date.now();
      let result: LlamaRnCompletionResult;
      try { result = await completion(options, onToken); }
      catch (cause) {
        const error = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {};
        const bounded = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : undefined;
        // Fixed synthetic lab only; before LocalModel replaces this with its safe public InferError.
        try { await record({ kind: 'rejection', elapsedMs: Date.now() - started, name: bounded(error.name, 128),
          message: bounded(error.message ?? cause, 4096), stack: bounded(error.stack, 8192), code: bounded(error.code, 128),
          truncated: [[error.name, 128], [error.message ?? cause, 4096], [error.stack, 8192], [error.code, 128]]
            .some(([value, max]) => typeof value === 'string' && value.length > Number(max)) }); }
        catch { /* The observer must never replace the original native rejection. */ }
        throw cause;
      }
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
