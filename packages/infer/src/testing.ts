import type { InferModel, InferModelStore } from './types.ts';
import type { InitLlama, LlamaRnCompletionParams, LlamaRnCompletionResult, LlamaRnContext, LlamaRnContextParams } from './model.ts';

export type FakeLlama = {
  initLlama: InitLlama;
  /** Every context made, in order, with what it was asked. */
  contexts: { params: LlamaRnContextParams; completions: LlamaRnCompletionParams[]; stops: number; released: boolean }[];
};

/**
 * llama.rn stand-in. `reply` answers each completion; a reply that never resolves models a long decode, which
 * `stopCompletion()` interrupts the way the native side does (resolving with `interrupted: true`).
 */
export function fakeLlama(o: { reply?: (p: LlamaRnCompletionParams) => string | Partial<LlamaRnCompletionResult> | Promise<string | Partial<LlamaRnCompletionResult>>;
  fail?: 'init' | 'completion'; tokensPerChar?: number } = {}): FakeLlama {
  const contexts: FakeLlama['contexts'] = [];
  const initLlama: InitLlama = async (params) => {
    if (o.fail === 'init') throw new Error('fake init failure');
    const record = { params, completions: [] as LlamaRnCompletionParams[], stops: 0, released: false };
    contexts.push(record);
    let interrupt: (() => void) | undefined;
    const ctx: LlamaRnContext = {
      gpu: false, model: { desc: 'fake', size: 0, nParams: 0 },
      tokenize: async (text) => ({ tokens: Array.from({ length: Math.ceil(text.length * (o.tokensPerChar ?? 0.25)) }, (_, i) => i) }),
      completion: async (p) => {
        if (record.released) throw new Error('released context');
        record.completions.push(p);
        if (o.fail === 'completion') throw new Error('fake completion failure');
        const base: LlamaRnCompletionResult = { text: '', content: '', tokens_predicted: 1, tokens_evaluated: 1, truncated: false,
          stopped_eos: true, stopped_word: '', stopped_limit: 0, context_full: false, interrupted: false };
        const stopped = new Promise<LlamaRnCompletionResult>(resolve => {
          interrupt = () => resolve({ ...base, stopped_eos: false, interrupted: true });
        });
        const answered = Promise.resolve(o.reply ? o.reply(p) : '{}').then(r => typeof r === 'string' ? { ...base, text: r, content: r } : { ...base, ...r });
        try { return await Promise.race([answered, stopped]); } finally { interrupt = undefined; }
      },
      stopCompletion: async () => { record.stops++; interrupt?.(); },
      release: async () => { record.released = true; },
    };
    return ctx;
  };
  return { initLlama, contexts };
}

/** In-memory store. `files` maps a model URL to the bytes its download yields; hashing uses Web Crypto. */
export function memoryModelStore(files: Record<string, Uint8Array> = {}, o: { freeBytes?: number; failDownload?: boolean } = {}) {
  const saved = new Map<string, Uint8Array>();
  const downloads: string[] = [];
  const store: InferModelStore = {
    path: (m: InferModel) => `/models/${m.id}.gguf`,
    size: async (m) => saved.get(m.id)?.byteLength,
    download: async (m, d) => {
      d.signal?.throwIfAborted();
      downloads.push(m.url);
      if (o.failDownload) throw new Error('fake network failure');
      const bytes = files[m.url] ?? new Uint8Array();
      d.onProgress?.(bytes.byteLength, m.bytes);
      saved.set(m.id, bytes);
    },
    sha256: async (m) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(saved.get(m.id) ?? [])))]
      .map(b => b.toString(16).padStart(2, '0')).join(''),
    remove: async (m) => { saved.delete(m.id); },
    ...(o.freeBytes !== undefined && { freeBytes: async () => o.freeBytes! }),
  };
  return { store, saved, downloads };
}
