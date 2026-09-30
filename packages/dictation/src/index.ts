import catalogue from './catalogue.json' with { type: 'json' };
import messages from './words.json' with { type: 'json' };
import { DictateError, type DictateEngine, type DictateSystemNative, type DictationState } from './types.ts';
export * from './types.ts';
export { Dictation } from './dictation.ts';
export { settleWords, applyWordReplacements } from './text.ts';
export { DEFAULT_WHISPER_MODEL, whisperRnEngine, whisperSettings, type WhisperSettings, type ResolvedWhisperSettings, type WhisperRnContext, type WhisperRnDecodeOptions, type WhisperRnResult } from './whisper.ts';
export const ROUTES = catalogue;
export function routes() { return catalogue.map(r => ({ ...r })); }
export const WORDS = messages;
export function stateWords(s: DictationState): string { return messages[s.phase]; }
export function errorWords(e: DictateError): string { return messages[e.code]; }
/** The app supplies its native recognizer. No global microphone or native module is discovered. */
export function systemEngine(native: DictateSystemNative): DictateEngine {
  return {
    info: { id: 'system', onDevice: true, streaming: 'native', account: 'none' },
    available: locale => native.available(locale ?? 'en-US'),
    start: (o, on) => native.start({ locale: o.languages?.[0] ?? 'en-US', partial: true, onDevice: true, punctuation: o.punctuation ?? true }, on),
    transcribe: (input, o) => {
      if (!native.transcribe) throw new DictateError('unsupported');
      return native.transcribe(input, o);
    },
  };
}
export type DictateModel = { id: string; url: string; bytes: number; sha256: string; multilingual: boolean };
export type DictateModelStore = {
  size(m: DictateModel): Promise<number | undefined>;
  download(m: DictateModel, o: { signal?: AbortSignal; onProgress?: (f: number) => void; resume: true }): Promise<void>;
  sha256(m: DictateModel): Promise<string>;
  remove(m: DictateModel): Promise<void>;
};
/** The host owns download/storage; corrupt or incomplete models are removed. */
export async function installModel(m: DictateModel, store: DictateModelStore, o: { signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes <= 0) throw new DictateError('bad-model');
  await store.download(m, { ...o, resume: true });
  if (await store.size(m) !== m.bytes || (await store.sha256(m)).toLowerCase() !== m.sha256.toLowerCase()) {
    await store.remove(m); throw new DictateError('bad-model');
  }
}
