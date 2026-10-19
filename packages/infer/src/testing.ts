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

/**
 * A `fakeLlama` reply that decodes the way llama.rn 0.12.9's default sampler chain does, one next-token logit map per
 * generated position: `top_k` (default 40), `top_p` (0.95) and `min_p` (0.05) cut the candidates, a temperature of 0
 * or less sets all but the highest logit to -inf, then `dist` softmaxes what is left and draws from it. `n_probs` reads
 * those candidates after sampling, as `rn-completion.cpp` does.
 */
export function sampledReply(positions: Record<string, number>[]) {
  return (p: LlamaRnCompletionParams): Partial<LlamaRnCompletionResult> => {
    let state = p.seed >>> 0; // mulberry32
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ state >>> 15, state | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 2 ** 32;
    };
    const softmax = (c: { tok: string; logit: number }[]) => {
      const max = c[0].logit, e = c.map(x => Math.exp(x.logit - max)), sum = e.reduce((a, b) => a + b, 0);
      return c.map((x, i) => ({ ...x, p: e[i] / sum }));
    };
    const tokens: string[] = [], probabilities: { content: string; probs: { tok_str: string; prob: number }[] }[] = [];
    for (const logits of positions) {
      let c = Object.entries(logits).map(([tok, logit]) => ({ tok, logit })).sort((a, b) => b.logit - a.logit);
      const topK = p.top_k ?? 40, topP = p.top_p ?? 0.95, minP = p.min_p ?? 0.05;
      if (topK > 0) c = c.slice(0, topK);
      if (topP < 1) { let sum = 0; c = c.slice(0, softmax(c).findIndex(x => (sum += x.p) >= topP) + 1); }
      if (minP > 0) { const s = softmax(c); c = c.filter((_, i) => s[i].p >= minP * s[0].p); }
      const s = softmax(c.map((x, i) => ({ ...x, logit: p.temperature > 0 ? x.logit / p.temperature : i === 0 ? x.logit : -Infinity })));
      let r = random(), pick = s[s.length - 1];
      for (const x of s) if ((r -= x.p) <= 0) { pick = x; break; }
      tokens.push(pick.tok);
      if (p.n_probs) probabilities.push({ content: pick.tok, probs: s.slice(0, p.n_probs).map(x => ({ tok_str: x.tok, prob: x.p })) });
    }
    const text = tokens.join('');
    return { text, content: text, tokens_predicted: tokens.length, ...(p.n_probs ? { completion_probabilities: probabilities } : {}) };
  };
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
