// `@byokit/speak` default entry: native-free, so it loads on every platform. On the web it speaks through the
// platform's own speechSynthesis; on Node (and anywhere without it) `speaker` is `unsupported` unless the host
// injects an engine with `createSpeaker`. React Native resolves `rn.ts` instead.
import { browserEngine } from './browser.ts';
import type { BrowserSynthesis, BrowserUtterance } from './browser.ts';
import { createSpeaker } from './speak.ts';

export type {
  NativeSpeak, NativeSpeakEvent, SpeakErrorCode, SpeakEvent, SpeakEventType, SpeakHandle, SpeakOptions, Speaker,
  Voice,
} from './types.ts';
export { SpeakError } from './types.ts';
export { createSpeaker } from './speak.ts';
export type { SpeakEngine } from './speak.ts';
export { browserEngine } from './browser.ts';
export { nativeEngine } from './native.ts';
export type { BrowserSynthesis, BrowserUtterance } from './browser.ts';

const synthesis = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;

export const speaker = createSpeaker(
  synthesis === null
    ? null
    : browserEngine(
      synthesis as unknown as BrowserSynthesis,
      () => new SpeechSynthesisUtterance() as unknown as BrowserUtterance,
    ),
);
