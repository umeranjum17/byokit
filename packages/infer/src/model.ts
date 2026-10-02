import { InferError, type Completion, type CompleteRequest, type InferDevice, type InferLimits, type InferModel, type InferModelStore, type InferState } from './types.ts';

/** Structural subset of llama.rn 0.12.9 (`initLlama`, `LlamaContext`); no runtime or type import of React Native. */
export type LlamaRnContextParams = {
  model: string; n_ctx: number; n_threads: number; n_gpu_layers: number; use_mlock: boolean; use_mmap: boolean;
};
export type LlamaRnMessage = { role: 'system' | 'user'; content: string };
export type LlamaRnCompletionParams = {
  messages: LlamaRnMessage[]; jinja: true; enable_thinking: false; n_predict: number; temperature: 0; seed: number;
  response_format?: { type: 'json_schema'; json_schema: { strict: true; schema: object } };
};
export type LlamaRnCompletionResult = {
  text: string; content: string; tokens_predicted: number; tokens_evaluated: number;
  truncated: boolean; stopped_eos: boolean; stopped_word: string; stopped_limit: number; context_full: boolean; interrupted: boolean;
};
export type LlamaRnContext = {
  gpu: boolean;
  model: { desc: string; size: number; nParams: number };
  tokenize(text: string): Promise<{ tokens: number[] }>;
  /** With `onToken`, llama.rn decodes token by token and calls it for each one. */
  completion(params: LlamaRnCompletionParams, onToken?: (data: { token: string }) => void): Promise<LlamaRnCompletionResult>;
  stopCompletion(): Promise<void>;
  release(): Promise<void>;
};
export type InitLlama = (params: LlamaRnContextParams) => Promise<LlamaRnContext>;

export type LocalModelOptions = {
  model: InferModel;
  store: InferModelStore;
  /** `initLlama` from llama.rn 0.12.9. Absent means this build has no binding: the state is `unsupported`. */
  initLlama?: InitLlama;
  device?: InferDevice;
  limits?: Partial<InferLimits>;
  onState?: (s: InferState) => void;
  /** Diagnostics only. Never receives prompt, pane or generated text. */
  log?: (line: string) => void;
};

// ponytail: minMemoryBytes and the token margin are unmeasured guesses; set them from the a4b93ea2/iPhone runs.
export const DEFAULT_LIMITS: InferLimits = {
  contextTokens: 2048, maxOutputTokens: 256, maxInputChars: 12_000, threads: 4, minMemoryBytes: 3_000_000_000, verifyOnLoad: true,
};
/** Room for the chat template's own tokens around system and prompt. */
const TEMPLATE_TOKENS = 64;
const ANDROID_ABIS = ['arm64-v8a', 'x86_64'];

/** Untrusted text cannot spell the chat template's control tokens (`<|im_start|>`, `<think>`), which llama.rn parses. */
export const neutralize = (s: string): string => s.replace(/<(?=\||\/?think>)/g, '‹');

export const modelName = (m: InferModel): string => `${m.id}@${m.revision}`;

// Stock React Native signals have aborted/listeners, but neither throwIfAborted nor reason.
const abortReason = (signal: AbortSignal): unknown => signal.reason !== undefined ? signal.reason
  : Object.assign(new Error('The on-device operation was cancelled.'), { name: 'AbortError' });
export function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortReason(signal); }

export function checkModel(m: InferModel): InferModel {
  const int = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  if (!m || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(m.id) || !/^[a-f0-9]{40}$/.test(m.revision)
    || !/^[a-f0-9]{64}$/.test(m.sha256) || !int(m.bytes) || !int(m.contextMax) || typeof m.file !== 'string' || !m.file.endsWith('.gguf')
    || typeof m.url !== 'string' || !m.url.startsWith('https://') || !m.url.includes(`/${m.revision}/`) || typeof m.licence !== 'string' || !m.licence) {
    throw new InferError('invalid', 'The model description is not a pinned GGUF file.');
  }
  return m;
}

function checkLimits(l: InferLimits, m: InferModel): InferLimits {
  const int = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
  if (!int(l.contextTokens, 256, Math.min(m.contextMax, 8192)) || !int(l.maxOutputTokens, 1, Math.min(1024, l.contextTokens - TEMPLATE_TOKENS - 1))
    || !int(l.maxInputChars, 1, 64_000) || !int(l.threads, 1, 16) || !int(l.minMemoryBytes, 0, Number.MAX_SAFE_INTEGER)
    || typeof l.verifyOnLoad !== 'boolean') throw new RangeError('Invalid on-device model limits.');
  return l;
}

/**
 * One downloaded model and at most one native context. Calls never queue: a call while another runs rejects `busy`,
 * so an app summarising the card on screen cancels the old call instead of piling work up.
 */
export class LocalModel {
  readonly model: InferModel;
  readonly limits: InferLimits;
  readonly #o: LocalModelOptions;
  #state: InferState;
  #ctx: LlamaRnContext | undefined;
  #verified = false;
  #op: Promise<unknown> | undefined;
  #stop: (() => void) | undefined;
  #releasing = false;

  constructor(o: LocalModelOptions) {
    this.#o = o;
    this.model = checkModel(o.model);
    this.limits = checkLimits({ ...DEFAULT_LIMITS, ...o.limits }, this.model);
    this.#state = this.#unsupported() ?? { phase: 'not-installed' };
  }

  get state(): InferState { return { ...this.#state }; }

  /** Reads the stored file's size (not its hash) and reports a truthful state. */
  check(): Promise<InferState> {
    return this.#exclusive(async () => {
      const unsupported = this.#unsupported();
      if (unsupported) return this.#set(unsupported);
      if (this.#ctx) return this.#set({ phase: 'ready' });
      return this.#set({ phase: await this.#o.store.size(this.model) === this.model.bytes ? 'installed' : 'not-installed' });
    });
  }

  /** Downloads `model.url` only, then checks size and SHA-256; a mismatching file is removed. Resumes a partial file. */
  install(o: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {}): Promise<void> {
    return this.#exclusive(async () => {
      throwIfAborted(o.signal);
      const unsupported = this.#unsupported();
      if (unsupported) { this.#set(unsupported); throw new InferError('unsupported', 'This device cannot run the model.'); }
      const { store } = this.#o, m = this.model;
      try {
        const have = await store.size(m) ?? 0;
        if (have === m.bytes && await this.#hashMatches()) { throwIfAborted(o.signal); this.#set({ phase: this.#ctx ? 'ready' : 'installed' }); return; }
        if (store.freeBytes && await store.freeBytes() + Math.min(have, m.bytes) < m.bytes) {
          throw new InferError('no-space', 'Not enough free space for the model.', { detail: { bytes: m.bytes } });
        }
      } catch (cause) {
        if (o.signal?.aborted) throw abortReason(o.signal);
        this.#set({ phase: 'failed', why: 'storage' });
        throw cause instanceof InferError ? cause : new InferError('failed', 'The model storage could not be checked.', { cause });
      }
      throwIfAborted(o.signal);
      this.#set({ phase: 'installing', received: 0, total: m.bytes });
      try {
        await store.download(m, { signal: o.signal, resume: true, onProgress: (received, total) => {
          this.#set({ phase: 'installing', received, total });
          o.onProgress?.(received, total);
        } });
      } catch (cause) {
        if (o.signal?.aborted) { this.#set({ phase: 'not-installed' }); throw abortReason(o.signal); }
        this.#set({ phase: 'failed', why: 'network' });
        throw new InferError('network', 'The model download failed.', { cause });
      }
      let matches;
      try {
        matches = await store.size(m) === m.bytes && await this.#hashMatches();
        if (!matches) await store.remove(m);
      } catch (cause) {
        this.#set({ phase: 'failed', why: 'storage' });
        throw new InferError('failed', 'The downloaded model could not be checked.', { cause });
      }
      if (!matches) {
        this.#set({ phase: 'failed', why: 'integrity' });
        throw new InferError('integrity', 'The downloaded file did not match the pinned size and SHA-256.');
      }
      this.#set({ phase: 'installed' });
      throwIfAborted(o.signal);
    });
  }

  /** Releases the context and deletes the model file. */
  async remove(): Promise<void> {
    await this.release();
    return this.#exclusive(async () => {
      await this.#o.store.remove(this.model);
      this.#verified = false;
      this.#set(this.#unsupported() ?? { phase: 'not-installed' });
    });
  }

  /** Aborting stops native decode, then rejects with the supplied reason (or AbortError on runtimes without reasons). */
  complete(req: CompleteRequest): Promise<Completion> {
    if (!req || typeof req.prompt !== 'string' || (req.system !== undefined && typeof req.system !== 'string')) {
      throw new TypeError('complete() needs a string prompt.');
    }
    const maxOutputTokens = req.maxOutputTokens ?? this.limits.maxOutputTokens;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > this.limits.maxOutputTokens) {
      throw new RangeError(`maxOutputTokens must be 1..${this.limits.maxOutputTokens}.`);
    }
    return this.#exclusive(async () => {
      const { signal } = req;
      throwIfAborted(signal);
      const system = req.system ?? '';
      if (system.length + req.prompt.length > this.limits.maxInputChars) throw new InferError('too-large', 'The input is longer than the limit.');
      const ctx = await this.#load();
      const prompt = neutralize(req.prompt);
      const inputTokens = (await ctx.tokenize(`${system}\n${prompt}`)).tokens.length + TEMPLATE_TOKENS;
      if (inputTokens + maxOutputTokens > this.limits.contextTokens) {
        throw new InferError('too-large', 'The input does not fit the context.', { detail: { inputTokens } });
      }
      const messages: LlamaRnMessage[] = [...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user', content: prompt }];
      const stop = () => { void ctx.stopCompletion().catch(() => {}); };
      // llama.rn clears a stop that lands before its native decode starts, so every token re-asserts it.
      const onToken = () => { if (signal?.aborted || this.#releasing) stop(); };
      signal?.addEventListener('abort', stop, { once: true });
      this.#stop = stop;
      const started = Date.now();
      try {
        throwIfAborted(signal);
        if (this.#releasing) throw new InferError('failed', 'The model was released.');
        this.#set({ phase: 'busy' });
        const r = await ctx.completion({ messages, jinja: true, enable_thinking: false, n_predict: maxOutputTokens, temperature: 0, seed: 0,
          ...(req.jsonSchema && { response_format: { type: 'json_schema' as const, json_schema: { strict: true as const, schema: req.jsonSchema } } }) }, onToken);
        throwIfAborted(signal);
        if (this.#releasing) throw new InferError('failed', 'The model was released while generating.');
        this.#set({ phase: 'ready' });
        return {
          text: r.content || r.text,
          stop: r.stopped_limit > 0 || r.context_full || r.truncated || r.interrupted ? 'limit' : r.stopped_word ? 'word' : 'eos',
          inputTokens: r.tokens_evaluated, outputTokens: r.tokens_predicted, ms: Date.now() - started, model: modelName(this.model),
        };
      } catch (cause) {
        if (signal?.aborted) { this.#set({ phase: 'ready' }); throw abortReason(signal); }
        if (cause instanceof InferError) { this.#set({ phase: 'ready' }); throw cause; }
        this.#set({ phase: 'failed', why: 'model' });
        this.#o.log?.('infer: native completion failed');
        throw new InferError('failed', 'The native completion failed.', { cause });
      } finally {
        signal?.removeEventListener('abort', stop);
        this.#stop = undefined;
      }
    });
  }

  /** Stops any generation, waits for it, and frees the native context. Safe to call repeatedly. A running install is not
   * stopped: abort it with its own signal. */
  async release(): Promise<void> {
    this.#releasing = true;
    try {
      this.#stop?.();
      while (this.#op) await this.#op;
      await this.#exclusive(async () => {
        const ctx = this.#ctx;
        this.#ctx = undefined;
        if (!ctx) return;
        await ctx.release();
        this.#set({ phase: 'installed' });
      });
    } finally { this.#releasing = false; }
  }

  async #load(): Promise<LlamaRnContext> {
    if (this.#ctx) return this.#ctx;
    const unsupported = this.#unsupported();
    if (unsupported) { this.#set(unsupported); throw new InferError('unsupported', 'This device cannot run the model.'); }
    const { store, initLlama } = this.#o, m = this.model;
    if (await store.size(m) !== m.bytes) { this.#set({ phase: 'not-installed' }); throw new InferError('not-installed', 'The model is not downloaded.'); }
    this.#set({ phase: 'loading' });
    let matches = true;
    try {
      if (this.limits.verifyOnLoad) matches = await this.#hashMatches();
      if (!matches) await store.remove(m);
    } catch (cause) {
      this.#set({ phase: 'failed', why: 'storage' });
      throw new InferError('failed', 'The stored model could not be checked.', { cause });
    }
    if (!matches) {
      this.#set({ phase: 'failed', why: 'integrity' });
      throw new InferError('integrity', 'The stored model no longer matches its SHA-256 and was removed.');
    }
    if (this.#releasing) { this.#set({ phase: 'installed' }); throw new InferError('failed', 'The model was released.'); }
    try {
      this.#ctx = await initLlama!({ model: store.path(m), n_ctx: this.limits.contextTokens, n_threads: this.limits.threads,
        n_gpu_layers: 0, use_mlock: false, use_mmap: true });
    } catch (cause) {
      this.#set({ phase: 'failed', why: 'model' });
      this.#o.log?.('infer: initLlama failed');
      throw new InferError('failed', 'The native context could not start.', { cause });
    }
    this.#set({ phase: 'ready' });
    return this.#ctx;
  }

  async #hashMatches(): Promise<boolean> {
    if (this.#verified) return true;
    this.#verified = (await this.#o.store.sha256(this.model)).toLowerCase() === this.model.sha256;
    return this.#verified;
  }

  #unsupported(): InferState | undefined {
    const d = this.#o.device;
    if (!this.#o.initLlama) return { phase: 'unsupported', why: 'binding' };
    if (d?.platform === 'other' || d?.platform === 'android' && d.abi !== undefined && !ANDROID_ABIS.includes(d.abi)) {
      return { phase: 'unsupported', why: 'device' };
    }
    if (d?.totalMemoryBytes !== undefined && d.totalMemoryBytes < this.limits.minMemoryBytes) return { phase: 'unsupported', why: 'memory' };
    return undefined;
  }

  #set(s: InferState): InferState {
    this.#state = s;
    this.#o.onState?.({ ...s });
    return this.state;
  }

  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#op) throw new InferError('busy', 'Another on-device call is running.');
    const run = fn();
    this.#op = run.catch(() => {});
    try { return await run; } finally { this.#op = undefined; }
  }
}
