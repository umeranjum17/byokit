export type InferErrorCode = 'unsupported' | 'not-installed' | 'invalid' | 'integrity' | 'no-space' | 'network' | 'busy' | 'too-large'
  | 'incomplete' | 'failed';

export class InferError extends Error {
  readonly code: InferErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: InferErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'InferError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}

/** One pinned, publicly licensed GGUF file. `url` is the only address the kit ever lets a store download. */
export type InferModel = {
  id: string; label: string; offer: boolean;
  repo: string; revision: string; file: string; url: string;
  bytes: number; sha256: string; licence: string; licenceUrl: string;
  /** Trained context length; the kit's own `limits.contextTokens` stays far below it. */
  contextMax: number;
  /** The chat template can think; the kit always turns thinking off through the template, not the prompt. */
  thinking: boolean;
};

export type InferState = {
  phase: 'unsupported' | 'not-installed' | 'installing' | 'installed' | 'loading' | 'ready' | 'busy' | 'failed';
  why?: 'device' | 'binding' | 'memory' | 'integrity' | 'storage' | 'network' | 'model';
  /** Bytes, while installing. */
  received?: number; total?: number;
};

/** What the host knows about the phone. Unknown fields are not guessed. */
export type InferDevice = { platform: 'android' | 'ios' | 'other'; abi?: string; totalMemoryBytes?: number };

export type InferLimits = {
  /** n_ctx of the one native context. */
  contextTokens: number;
  /** Ceiling for every call; a call may ask for less. */
  maxOutputTokens: number;
  /** Input characters (system + prompt) refused before tokenizing. */
  maxInputChars: number;
  threads: number;
  /** Refuse to load below this much total RAM when the host reports it. */
  minMemoryBytes: number;
  /** Re-hash the file once per LocalModel before its first load. */
  verifyOnLoad: boolean;
};

/**
 * The host's file storage (for example over @dr.pogodin/react-native-fs). It keeps each model at one path of its own
 * choosing, downloads only `m.url` and hashes natively. The kit never sees a directory listing.
 */
export type InferModelStore = {
  path(m: InferModel): string;
  size(m: InferModel): Promise<number | undefined>;
  download(m: InferModel, o: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void; resume: true }): Promise<void>;
  sha256(m: InferModel): Promise<string>;
  remove(m: InferModel): Promise<void>;
  freeBytes?(): Promise<number>;
};

export type CompleteRequest = {
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
  /** Constrain the output to this JSON Schema through the engine's grammar. */
  jsonSchema?: object;
  signal?: AbortSignal;
};

export type Completion = {
  text: string;
  /** `limit` means the text was cut off: it is never a complete answer. */
  stop: 'eos' | 'word' | 'limit';
  inputTokens: number; outputTokens: number; ms: number;
  /** `<id>@<revision>`. */
  model: string;
};
