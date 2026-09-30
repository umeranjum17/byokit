export * from './portable.ts';
export type { NativeOptions, SecureStoreLike, SecureStoreOptions } from './native.ts';
import { nativeStoreWith, type NativeOptions } from './native.ts';
import type { Keystore } from './types.ts';

/** SecureStore is an optional peer, loaded only when an operation needs it. */
export function nativeStore(options: NativeOptions = {}): Keystore {
  return nativeStoreWith(options, () => import('expo-secure-store'));
}
