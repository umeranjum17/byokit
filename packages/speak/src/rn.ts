// `@byokit/speak` React Native entry: the only file loading the 'ByokitSpeak' native module. Where the lookup
// is null (Expo Go, or a build without the module) `speaker` is `unsupported`.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { nativeEngine } from './native.ts';
import { createSpeaker } from './speak.ts';
import type { NativeSpeak } from './types.ts';

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

const native = requireOptionalNativeModule<NativeSpeak>('ByokitSpeak');

export const speaker = createSpeaker(native === null ? null : nativeEngine(native));
