// `@byokit/overlay/focused-field` React Native entry (docs/capability-kits.md 7.4): the 'ByokitFocusedField' native
// module when the app has it (Android), else the default entry's field that is never available (iOS).
import { requireOptionalNativeModule } from 'expo-modules-core';
import { focusedField as none, type FocusedField, type FocusedText, type InsertResult } from './focused-field.ts';

export type { FocusedField, FocusedText, InsertResult } from './focused-field.ts';

/** What the Kotlin module exposes: insert takes the replace mode as a plain argument. */
type NativeFocusedField = {
  available(): Promise<boolean>;
  read(): Promise<FocusedText | null>;
  insert(text: string, replace: 'selection' | 'all'): Promise<InsertResult>;
};

const native = requireOptionalNativeModule<NativeFocusedField>('ByokitFocusedField');

export const focusedField: FocusedField = native ? {
  available: () => native.available(),
  read: () => native.read(),
  insert: (text, o) => native.insert(text, o?.replace ?? 'selection'),
} : none;
