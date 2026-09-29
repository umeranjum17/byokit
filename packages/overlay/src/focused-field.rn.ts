// `@byokit/overlay/focused-field` React Native entry (docs/capability-kits.md 7.4): the 'ByokitFocusedField' native
// module when the app has it (Android), else the default entry's field that is never available (iOS).
import { requireOptionalNativeModule } from 'expo-modules-core';
import { focusedField as none, type FocusedField } from './focused-field.ts';

export type { FocusedField, FocusedText, InsertResult } from './focused-field.ts';

export const focusedField: FocusedField = requireOptionalNativeModule<FocusedField>('ByokitFocusedField') ?? none;
