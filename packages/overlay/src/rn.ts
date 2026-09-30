// `@byokit/overlay` React Native entry (docs/capability-kits.md 7.3): the only file loading the 'ByokitOverlay' native
// module. It is built for Android only, so on iOS the lookup is null and `overlay` is `unsupported`.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { createOverlay } from './overlay.ts';
import type { NativeOverlay } from './types.ts';

export type {
  AppRules, Edge, ForegroundNotice, HostKind, NativeOverlay, Overlay, OverlayEvent, OverlayEventType, OverlayState,
  StartOptions, TapEntry, PointHereOptions, PointHereResult,
} from './types.ts';
export { resetApp, setApp, shownFor } from './rules.ts';
export { createOverlay } from './overlay.ts';
export { stateWords, words } from './words.ts';

export const overlay = createOverlay(requireOptionalNativeModule<NativeOverlay>('ByokitOverlay'));

export type { ScreenSpace } from './screen-frame.ts';
