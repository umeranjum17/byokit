// `@byokit/share` React Native entry (docs/capability-kits.md 14): the only file importing react, react-native,
// expo-modules-core, expo-linking and expo-share-intent at runtime. Android reads the kit's own 'ByokitShare'
// module (expo-share-intent's Android module is not linked); iOS uses upstream's module behind the link check.
import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useLinkingURL } from 'expo-linking';
import { ShareIntentModule as upstream, getScheme, getShareExtensionKey, parseShareIntent } from 'expo-share-intent';
import { createAndroidShareModule, guardIosShareModule } from './adapter.ts';
import { createUseShareIntent, EMPTY_SHARE } from './hook.ts';
import type { NativeShare, ShareIntentModuleLike, ShareIntentOptions, ShareIntentState } from './types.ts';

export type * from './types.ts';
export { createUseShareIntent } from './hook.ts';
export { isValidShareUrl } from './url.ts';
export { WORDS, errorWords, words, ShareError, type WordKey } from './words.ts';
export { getScheme, getShareExtensionKey, parseShareIntent };

const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeShare>('ByokitShare') : null;
const ios = Platform.OS === 'ios' && upstream ? (upstream as unknown as ShareIntentModuleLike) : null;

/** True where the kit can receive shares: Android with the kit linked, or iOS with upstream's module. */
export const shareSupported = !!(native || ios);

export const ShareIntentModule: ShareIntentModuleLike | null =
  native ? createAndroidShareModule(native) : ios ? guardIosShareModule(ios, () => getScheme()) : null;

// The hook checks each link against the scheme its options give, so on iOS it gets upstream's module itself.
export const useShareIntent = createUseShareIntent({
  module: native ? ShareIntentModule : ios, native, useLinkingURL: native ? undefined : useLinkingURL,
  parse: parseShareIntent, getScheme, getShareExtensionKey,
  react: { useState, useEffect, useRef }, appState: AppState, os: Platform.OS,
});

// Upstream's provider and context (ShareIntentProvider.js:4-24), with the additive defaults.
const ShareIntentContext = createContext<ShareIntentState>({
  isReady: false, hasShareIntent: false, shareIntent: EMPTY_SHARE, resetShareIntent: () => {}, error: null,
  errorCode: null, skipped: 0, skipReasons: [],
});
export const ShareIntentContextConsumer = ShareIntentContext.Consumer;
export const useShareIntentContext = (): ShareIntentState => useContext(ShareIntentContext);
export function ShareIntentProvider({ options, children }: { options?: ShareIntentOptions; children: ReactNode }) {
  return createElement(ShareIntentContext.Provider, { value: useShareIntent(options) }, children);
}
