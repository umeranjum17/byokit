// `@byokit/overlay/focused-field` React Native entry (docs/capability-kits.md 7.4): the 'ByokitFocusedField' native
// module when the app has it (Android), else the default entry's field that is never available (iOS).
import { requireOptionalNativeModule } from 'expo-modules-core';
import { focusedField as none, type FocusedField, type FocusedText, type InsertResult } from './focused-field.ts';

export type { FocusedField, FocusedText, InsertOptions, InsertResult } from './focused-field.ts';

/** What the Kotlin module exposes: insert takes its options as a plain record. */
type NativeFocusedField = {
  available(): Promise<boolean>;
  read(): Promise<FocusedText | null>;
  insert(text: string, o: { replace: string; attempts: number; retryMs: number; acceptNewlineLoss: boolean }): Promise<InsertResult>;
};

const native = requireOptionalNativeModule<NativeFocusedField>('ByokitFocusedField');

const ATTEMPTS = 2;
const RETRY_MS = 150;

export const focusedField: FocusedField = native ? {
  available: () => native.available(),
  read: () => native.read(),
  insert: (text, o) => native.insert(text, {
    replace: o?.replace ?? 'selection',
    attempts: o?.attempts ?? ATTEMPTS,
    retryMs: o?.retryMs ?? RETRY_MS,
    acceptNewlineLoss: o?.acceptNewlineLoss ?? false,
  }),
} : none;
