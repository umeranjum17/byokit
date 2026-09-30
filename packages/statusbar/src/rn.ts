// `@byokit/statusbar` React Native entry (docs/capability-kits.md 12.3): the only file loading the 'ByokitStatus' native
// module. It is built for Android only, so on iOS the lookup is null and `status` is `unsupported`.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { createStatus } from './status.ts';
import type { NativeStatus } from './types.ts';

export type { NativeStatus, ShowOptions, Status, StatusAction, StatusEvent, StatusEventType, StatusState } from './types.ts';
export { createStatus } from './status.ts';
export { stateWords, words } from './words.ts';

export const status = createStatus(requireOptionalNativeModule<NativeStatus>('ByokitStatus'));
