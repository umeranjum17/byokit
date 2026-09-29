// `@byokit/overlay/focused-field` default entry (docs/capability-kits.md 7.4): no native module here, so nothing is
// ever available, read or typed in. React Native resolves `focused-field.rn.ts` instead.

export type FocusedText = { app: string; text: string; selection: { start: number; end: number } | null };
export type InsertResult = 'inserted' | 'landedWithoutNewlines' | 'copied' | 'failed';
export type InsertOptions = {
  replace?: 'selection' | 'all';   // default 'selection'
  attempts?: number;               // SET_TEXT tries; default 2 (a panel on top needs ~13 x 150 ms in Chrome)
  retryMs?: number;                // pause between tries; default 150
  acceptNewlineLoss?: boolean;     // default false; true resolves 'landedWithoutNewlines' when only newlines were lost
};
export interface FocusedField {
  available(): Promise<boolean>;       // the app's accessibility service has attached the kit
  read(): Promise<FocusedText | null>; // only on this call; null when no editable field has focus
  insert(text: string, o?: InsertOptions): Promise<InsertResult>;
}

export const focusedField: FocusedField = {
  available: async () => false,
  read: async () => null,
  insert: async () => 'failed',
};
