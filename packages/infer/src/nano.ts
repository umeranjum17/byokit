import { InferError, type InferErrorCode, type Completion, type CompleteRequest, type InferLimits, type InferState } from './types.ts';
import { DEFAULT_LIMITS, abortReason, throwIfAborted } from './model.ts';

/**
 * Structural subset of ML Kit GenAI Prompt 1.0.0-beta4 `GenerativeModel` (Android's built-in Gemini Nano, run by AICore),
 * as a thin native module exposes it; no runtime or type import of React Native or Android. Rejections carry
 * `GenAiException.errorCode` as a numeric `errorCode`. Not reachable from JS, so not typed: Kotlin-only typed
 * (`@Generable`) output, image parts, the `Caches` object.
 */
export type NanoFeatureStatus = 0 | 1 | 2 | 3; // UNAVAILABLE, DOWNLOADABLE, DOWNLOADING, AVAILABLE
export type NanoRequest = { text: string; systemInstruction?: string; temperature?: number; topK?: number; seed?: number;
  maxOutputTokens?: number; candidateCount?: number; enableThinking?: boolean };
/** `finishReason`: STOP 0, MAX_TOKENS 1, OTHER -100. */
export type NanoResponse = { candidates: { text: string; finishReason: number | null }[] };
export type NanoBinding = {
  checkStatus(): Promise<NanoFeatureStatus>;
  /** `onText` is ML Kit's StreamingCallback: each new piece of text as it is generated. */
  generateContent(request: NanoRequest, onText?: (text: string) => void): Promise<NanoResponse>;
  countTokens(request: NanoRequest): Promise<{ totalTokens: number }>;
  getTokenLimit(): Promise<number>; getBaseModelName(): Promise<string>;
  /** `cancel` stops the running generateContent coroutine (ML Kit has no cancel call). After `close`, the module makes a
   * new client on its next call. */
  cancel(): void; close(): void;
  download?(onProgress?: (bytes: number) => void): Promise<void>; warmup?(): Promise<void>; clearImplicitCaches?(): Promise<void>;
  isSystemPromptAvailable?(): Promise<boolean>; isStructuredOutputFeatureAvailable?(): Promise<boolean>;
  isThinkingModeAvailable?(): Promise<boolean>; isCachingFeatureAvailable?(): Promise<boolean>;
};

export type NanoModelOptions = {
  /** The app's native module over ML Kit GenAI Prompt. Absent (iOS, other hosts): the state is `unsupported`. */
  binding?: NanoBinding;
  limits?: Partial<Pick<InferLimits, 'maxOutputTokens' | 'maxInputChars'>>;
  /** How long `check()` waits for AICore before calling Nano unsupported. Default 3000. */
  statusMs?: number;
  /** `log` gets diagnostics only, never prompt or generated text. */
  onState?: (s: InferState) => void; log?: (line: string) => void;
};

// GenAiException codes: BUSY, PER_APP_BATTERY_USE_QUOTA_EXCEEDED, BACKGROUND_USE_BLOCKED; NOT_AVAILABLE, NOT_SUPPORTED,
// AICORE_INCOMPATIBLE, NEEDS_SYSTEM_UPDATE, feature not available; per-request REQUEST_TOO_SMALL, REQUEST_PROCESSING_ERROR,
// CANCELLED, RESPONSE_PROCESSING_ERROR, RESPONSE_GENERATION_ERROR, NOT_ENOUGH_DISK_SPACE. REQUEST_TOO_LARGE is 12.
const BUSY = [9, 27, 30], ABSENT = [8, 16, -101, 604, 606], REQUEST = [-100, 4, 7, 11, 15, 501];

/**
 * Android's built-in Gemini Nano: on the phone, no download by this kit, one call at a time (`busy`). Only AVAILABLE is
 * `ready`; DOWNLOADABLE/DOWNLOADING are `not-installed`/`installing` (AICore owns that download, `binding.download()`).
 */
export class NanoModel {
  readonly binding?: NanoBinding;
  readonly limits: Pick<InferLimits, 'maxOutputTokens' | 'maxInputChars'>;
  readonly #o: NanoModelOptions;
  #state: InferState;
  #name = 'gemini-nano';
  #op: Promise<unknown> | undefined;
  #checking: Promise<InferState> | undefined;

  constructor(o: NanoModelOptions = {}) {
    this.#o = o; this.binding = o.binding;
    const { maxOutputTokens: out, maxInputChars: chars } = { ...DEFAULT_LIMITS, ...o.limits };
    if (![out, chars].every(Number.isSafeInteger) || out < 1 || out > 4096 || chars < 1) throw new RangeError('Invalid on-device model limits.');
    this.limits = { maxOutputTokens: out, maxInputChars: chars };
    this.#state = o.binding ? { phase: 'not-installed' } : { phase: 'unsupported', why: 'binding' };
  }

  get state(): InferState { return { ...this.#state }; }
  /** `gemini-nano@<base model name>` once AICore reported it, else `gemini-nano`. */
  get id(): string { return this.#name; }

  /** Asks AICore whether Nano can run now. A missing, failing or silent AICore is `unsupported`, never a hang. A failed
   * generation stays `failed` (AICore can report AVAILABLE while every inference fails) until `release()`. */
  check(): Promise<InferState> {
    if (this.#op) return this.#checking ?? Promise.resolve(this.state); // a running call: Nano is ready (busy).
    return this.#exclusive(() => this.#check());
  }

  complete(req: CompleteRequest): Promise<Completion> {
    if (!req || typeof req.prompt !== 'string' || (req.system !== undefined && typeof req.system !== 'string')) throw new TypeError('complete() needs a string prompt.');
    const maxOutputTokens = req.maxOutputTokens ?? this.limits.maxOutputTokens;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > this.limits.maxOutputTokens) {
      throw new RangeError(`maxOutputTokens must be 1..${this.limits.maxOutputTokens}.`);
    }
    return this.#exclusive(async () => {
      const { signal } = req;
      throwIfAborted(signal);
      if ((req.system ?? '').length + req.prompt.length > this.limits.maxInputChars) throw new InferError('too-large', 'The input is longer than the limit.');
      if (this.#state.phase !== 'ready' && (await this.#check()).phase !== 'ready') {
        const { phase } = this.#state;
        throw new InferError(phase === 'unsupported' || phase === 'failed' ? phase : 'not-installed', 'Gemini Nano is not available on this phone.');
      }
      const b = this.binding!;
      // ponytail: no grammar from JS (typed output is Kotlin-only); the schema is asked for in words and the caller's
      // JSON validation stays authoritative. Grammar-equivalence with the GGUF path is unmeasured.
      const system = [req.system, req.jsonSchema && `Answer with JSON only, matching this JSON Schema: ${JSON.stringify(req.jsonSchema)}`].filter(Boolean).join('\n\n');
      const request: NanoRequest = { text: req.prompt, ...(system && { systemInstruction: system }), temperature: 0, topK: 1, seed: 0, maxOutputTokens };
      const stop = () => { try { b.cancel(); } catch { /* already finished */ } };
      signal?.addEventListener('abort', stop, { once: true });
      const started = Date.now();
      try {
        const native = <T>(p: Promise<T>) => settle(p, { signal });
        const inputTokens = (await native(b.countTokens(request))).totalTokens;
        if (inputTokens + maxOutputTokens > await native(b.getTokenLimit())) throw new InferError('too-large', 'The input does not fit the context.', { detail: { inputTokens } });
        throwIfAborted(signal);
        this.#set({ phase: 'busy' });
        const c = (await native(b.generateContent(request)))?.candidates?.[0];
        if (typeof c?.text !== 'string') throw new InferError('failed', 'Gemini Nano returned no answer.');
        // Usage only (ML Kit reports none): a failed count never discards the answer.
        const outputTokens = c.text ? await native(b.countTokens({ text: c.text })).then(r => r.totalTokens, () => Math.ceil(c.text.length / 4)) : 0;
        this.#set({ phase: 'ready' });
        return { text: c.text, stop: c.finishReason === 0 ? 'eos' : 'limit', inputTokens, outputTokens, ms: Date.now() - started, model: this.#name };
      } catch (cause) {
        if (signal?.aborted) { this.#set({ phase: 'ready' }); throw abortReason(signal); }
        if (cause instanceof InferError) { this.#set({ phase: 'ready' }); throw cause; }
        throw this.#fail(cause);
      } finally { signal?.removeEventListener('abort', stop); }
    });
  }

  /** Stops a running call and closes the native client. */
  async release(): Promise<void> {
    if (!this.binding) return;
    try { this.binding.cancel(); } catch { /* nothing running */ }
    while (this.#op) await this.#op;
    this.binding.close();
    if (this.#state.phase !== 'unsupported') this.#set({ phase: 'not-installed' });
  }

  #check(): Promise<InferState> {
    return this.#checking ??= this.#status().finally(() => { this.#checking = undefined; });
  }

  async #status(): Promise<InferState> {
    const b = this.binding;
    if (!b) return this.#set({ phase: 'unsupported', why: 'binding' });
    if (this.#state.phase === 'failed') return this.state;
    const ms = this.#o.statusMs ?? 3000;
    try {
      const status = await settle(Promise.resolve().then(() => b.checkStatus()), { ms });
      // The base model name is a label only: its failure or silence never decides the phase.
      const name = status === 3 && await settle(Promise.resolve().then(() => b.getBaseModelName()), { ms }).catch(() => '');
      if (name) this.#name = `gemini-nano@${name}`;
      return this.#set(status === 3 ? { phase: 'ready' } : status === 2 ? { phase: 'installing' } : status === 1 ? { phase: 'not-installed' }
        : { phase: 'unsupported', why: 'device' });
    } catch {
      this.#o.log?.('infer: nano status unavailable');
      return this.#set({ phase: 'unsupported', why: 'binding' });
    }
  }

  #fail(cause: unknown): InferError {
    const n = (cause as { errorCode?: unknown } | null)?.errorCode, code = typeof n === 'number' ? n : NaN;
    this.#o.log?.(`infer: nano failed ${code}`);
    const [c, s]: [InferErrorCode, InferState] = BUSY.includes(code) ? ['busy', { phase: 'ready' }] : code === 12 ? ['too-large', { phase: 'ready' }]
      : REQUEST.includes(code) ? ['failed', { phase: 'ready' }] : ABSENT.includes(code) ? ['unsupported', { phase: 'unsupported', why: 'device' }] : ['failed', { phase: 'failed', why: 'model' }];
    this.#set(s);
    return new InferError(c, 'Gemini Nano did not answer.', { cause });
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

/** `p`, or a rejection once `signal` aborts or `ms` passes; leaves no listener or timer behind. */
function settle<T>(p: Promise<T>, o: { signal?: AbortSignal; ms?: number }): Promise<T> {
  let done = () => {};
  const gate = new Promise<never>((_, reject) => {
    const abort = () => reject(o.signal!.reason);
    const timer = o.ms === undefined ? undefined : setTimeout(() => reject(new Error('timeout')), o.ms);
    if (o.signal?.aborted) abort(); else o.signal?.addEventListener('abort', abort, { once: true });
    done = () => { clearTimeout(timer); o.signal?.removeEventListener('abort', abort); };
  });
  return Promise.race([p, gate]).finally(done);
}
