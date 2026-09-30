// `@byokit/overlay` default entry (docs/capability-kits.md 7.3): native-free, so it loads on every platform. Here
// there is no native module, so `overlay` is `unsupported`; React Native resolves `rn.ts` instead.
import { createOverlay } from './overlay.ts';

export type {
  AppRules, Edge, ForegroundNotice, HostKind, NativeOverlay, Overlay, OverlayEvent, OverlayEventType, OverlayState,
  StartOptions, TapEntry, PointHereOptions, PointHereResult,
} from './types.ts';
export { resetApp, setApp, shownFor } from './rules.ts';
export { createOverlay } from './overlay.ts';
export { stateWords, words } from './words.ts';

export const overlay = createOverlay(null);

export type { ScreenSpace } from './screen-frame.ts';
