import type { InferModel, InferModelStore } from './types.ts';
import type { NanoBinding, NanoFeatureStatus, NanoRequest } from './nano.ts';
import { throwIfAborted, type InitLlama, type LlamaRnCompletionParams, type LlamaRnCompletionResult, type LlamaRnContext, type LlamaRnContextParams } from './model.ts';

export type FakeLlama = {
  initLlama: InitLlama;
  /** Every context made, in order, with what it was asked. */
  contexts: { params: LlamaRnContextParams; completions: LlamaRnCompletionParams[]; stops: number; released: boolean }[];
};

/**
 * llama.rn stand-in. `reply` answers each completion; a reply that never resolves models a long decode, which
 * `stopCompletion()` interrupts the way the native side does (resolving with `interrupted: true`). Like llama.rn, a
 * stop that arrives before a decode has started is lost; with `onToken`, a first token follows on the next tick.
 * `tokenizeGate` holds `tokenize()` until it resolves.
 */
export function fakeLlama(o: { reply?: (p: LlamaRnCompletionParams) => string | Partial<LlamaRnCompletionResult> | Promise<string | Partial<LlamaRnCompletionResult>>;
  fail?: 'init' | 'completion'; tokensPerChar?: number; tokenizeGate?: Promise<void> } = {}): FakeLlama {
  const contexts: FakeLlama['contexts'] = [];
  const initLlama: InitLlama = async (params) => {
    if (o.fail === 'init') throw new Error('fake init failure');
    const record = { params, completions: [] as LlamaRnCompletionParams[], stops: 0, released: false };
    contexts.push(record);
    let interrupt: (() => void) | undefined;
    const ctx: LlamaRnContext = {
      gpu: false, model: { desc: 'fake', size: 0, nParams: 0 },
      tokenize: async (text) => (await o.tokenizeGate, { tokens: Array.from({ length: Math.ceil(text.length * (o.tokensPerChar ?? 0.25)) }, (_, i) => i) }),
      completion: async (p, onToken) => {
        if (record.released) throw new Error('released context');
        record.completions.push(p);
        if (o.fail === 'completion') throw new Error('fake completion failure');
        const base: LlamaRnCompletionResult = { text: '', content: '', tokens_predicted: 1, tokens_evaluated: 1, truncated: false,
          stopped_eos: true, stopped_word: '', stopped_limit: 0, context_full: false, interrupted: false };
        // llama.rn formats the chat natively before decoding; a stop in this gap is lost, as on the phone.
        await new Promise(r => setTimeout(r, 0));
        const stopped = new Promise<LlamaRnCompletionResult>(resolve => {
          interrupt = () => resolve({ ...base, stopped_eos: false, interrupted: true });
        });
        const answered = Promise.resolve(o.reply ? o.reply(p) : '{}').then(r => typeof r === 'string' ? { ...base, text: r, content: r } : { ...base, ...r });
        if (onToken) setTimeout(() => onToken({ token: '' }), 0);
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
      throwIfAborted(d.signal);
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

/**
 * ML Kit GenAI Prompt stand-in. `status` answers checkStatus (a promise that never settles models a silent AICore);
 * `reply` answers generateContent (a string means finishReason STOP); `failCode` rejects it with that `errorCode`.
 * A reply that never resolves models a long decode, which `cancel()` interrupts. Tokens are 4 characters each.
 */
export function fakeNano(o: { status?: NanoFeatureStatus | Promise<NanoFeatureStatus>; reply?: (r: NanoRequest) => string | { text: string; finishReason: number } | Promise<string>;
  failCode?: number } = {}) {
  const requests: NanoRequest[] = [];
  let cancels = 0, closed = 0, interrupt: (() => void) | undefined;
  const binding: NanoBinding = {
    checkStatus: async () => o.status ?? 3,
    generateContent: async (r) => {
      requests.push(r);
      if (o.failCode !== undefined) throw Object.assign(new Error('fake GenAiException'), { errorCode: o.failCode });
      const cancelled = new Promise<never>((_, reject) => { interrupt = () => reject(Object.assign(new Error('cancelled'), { errorCode: 7 })); });
      let a;
      try { a = await Promise.race([Promise.resolve(o.reply ? o.reply(r) : '{}'), cancelled]); } finally { interrupt = undefined; }
      return { candidates: [typeof a === 'string' ? { text: a, finishReason: 0 } : a] };
    },
    countTokens: async (r) => ({ totalTokens: Math.ceil(((r.systemInstruction ?? '') + r.text).length / 4) }),
    getTokenLimit: async () => 4000,
    getBaseModelName: async () => 'nano-fake',
    cancel: () => { cancels++; interrupt?.(); },
    close: () => { closed++; },
  };
  return { binding, requests, get cancels() { return cancels; }, get closed() { return closed; } };
}
