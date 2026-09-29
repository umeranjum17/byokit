// `@byokit/overlay/focused-field` default entry (docs/capability-kits.md 7.4): no native module here, so nothing is
// ever available, read or typed in. React Native resolves `focused-field.rn.ts` instead.

export type FocusedText = { app: string; text: string; selection: { start: number; end: number } | null };
export type InsertResult = 'inserted' | 'copied' | 'failed';
export interface FocusedField {
  available(): Promise<boolean>;       // the app's accessibility service has attached the kit
  read(): Promise<FocusedText | null>; // only on this call; null when no editable field has focus
  insert(text: string, o?: { replace?: 'selection' | 'all' }): Promise<InsertResult>;   // default 'selection'
}

export const focusedField: FocusedField = {
  available: async () => false,
  read: async () => null,
  insert: async () => 'failed',
};
