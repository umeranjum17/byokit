// `@byokit/status` default entry (docs/capability-kits.md 12.3): native-free, so it loads on every platform. Here
// there is no native module, so `status` is `unsupported`; React Native resolves `rn.ts` instead.
import { createStatus } from './status.ts';

export type { NativeStatus, ShowOptions, Status, StatusAction, StatusEvent, StatusEventType, StatusState } from './types.ts';
export { createStatus } from './status.ts';
export { stateWords, words } from './words.ts';

export const status = createStatus(null);
