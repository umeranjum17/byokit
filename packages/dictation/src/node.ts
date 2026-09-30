import { fork } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { DictateError, type DictateEngine, type DictateEngineInfo, type DictateInput, type DictateOptions, type DictateTranscript, type DictateErrorCode } from './types.ts';
export type ProcessOptions = { env?: Record<string, string>; timeoutMs?: number };
export type Access = (signal?: AbortSignal) => Promise<{ access: string; accountId?: string }>;
export type AdapterConfig = { id: 'openai' | 'openrouter' | 'chatgpt' | 'whisper'; key?: string; accountId?: string; model?: string; endpoint?: string; binary?: string; modelPath?: string; threads?: number };
/** One isolated child per inference; no environment or credentials are discovered. */
function childEngine(info: DictateEngineInfo, config: AdapterConfig, processOptions: ProcessOptions, access?: Access): DictateEngine {
  return { info, async transcribe(input: DictateInput, o: DictateOptions) {
    o.signal?.throwIfAborted();
    const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
    if (bytes.byteLength > 25 * 1024 * 1024) throw new DictateError('too-large');
    const credential = await access?.(o.signal);
    o.signal?.throwIfAborted();
    if (access && !credential?.access) throw new DictateError('signed-out');
    const suffix = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    return new Promise<Omit<DictateTranscript, 'engine'>>((resolve, reject) => {
      const child = fork(new URL(`./worker.${suffix}`, import.meta.url), [], {
        env: { ...processOptions.env }, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let settled = false;
      const done = (error?: unknown, result?: Omit<DictateTranscript, 'engine'>) => {
        if (settled) return; settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', abort);
        if (child.connected) child.disconnect();
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => { if (child.connected) child.send({ cancel: true }); done(new DictateError('cancelled')); };
      const timer = setTimeout(abort, processOptions.timeoutMs ?? 60_000);
      o.signal?.addEventListener('abort', abort, { once: true });
      child.once('error', () => done(new DictateError('unsupported')));
      child.once('exit', () => { if (!settled) done(new DictateError('network')); });
      child.once('message', (message: { result?: Omit<DictateTranscript, 'engine'>; code?: DictateErrorCode; until?: number }) => {
        if (message.code) done(new DictateError(message.code, { until: message.until }));
        else if (message.result) done(undefined, message.result);
        else done(new DictateError('network'));
      });
      const { signal: _signal, ...options } = o;
      child.send({ config: { ...config, ...(credential ? { key: credential.access, accountId: credential.accountId } : {}) }, bytes, options, mime: input instanceof Blob ? input.type : 'audio/wav' });
    });
  } };
}
export function openaiEngine(o: ProcessOptions & { key: string; model?: string; endpoint?: string }): DictateEngine {
  return childEngine({ id: 'openai', model: o.model ?? 'whisper-1', onDevice: false, streaming: 'utterance', account: 'key' }, { id: 'openai', key: o.key, model: o.model ?? 'whisper-1', endpoint: o.endpoint }, o);
}
/** An OpenRouter account may supply its sign-in key through access; billing remains per use. */
export function openrouterEngine(o: ProcessOptions & { key?: string; access?: Access; model: string; endpoint?: string }): DictateEngine {
  if (!o.key && !o.access) throw new DictateError('bad-key');
  return childEngine({ id: 'openrouter', model: o.model, onDevice: false, streaming: 'utterance', account: 'key' }, { id: 'openrouter', key: o.key, model: o.model, endpoint: o.endpoint }, o, o.access);
}
/** Bind the selected person's @byokit/accounts credential accessor; no login-file reads or API fallback. */
export function chatgptEngine(o: ProcessOptions & { access: Access; endpoint?: string }): DictateEngine {
  return childEngine({ id: 'chatgpt', onDevice: false, streaming: 'utterance', account: 'plan' }, { id: 'chatgpt', endpoint: o.endpoint }, o, o.access);
}
/** whisper.cpp CLI, explicitly passed by the app; never searches PATH or downloads a model. */
export function whisperEngine(o: ProcessOptions & { binary: string; modelPath: string; threads?: number }): DictateEngine {
  if (!isAbsolute(o.binary) || !isAbsolute(o.modelPath)) throw new DictateError('bad-model');
  if (o.threads !== undefined && (!Number.isInteger(o.threads) || o.threads < 1 || o.threads > 64)) throw new DictateError('bad-model');
  return childEngine({ id: 'whisper', model: o.modelPath.split('/').at(-1), onDevice: true, streaming: 'reread', account: 'none' }, { id: 'whisper', binary: o.binary, modelPath: o.modelPath, threads: o.threads ?? 6 }, o);
}
