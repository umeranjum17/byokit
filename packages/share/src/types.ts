export type {
  ShareIntent, ShareIntentFile, ShareIntentMeta, ShareIntentOptions,
  AndroidShareIntent, AndroidShareIntentFile, IosShareIntent, IosShareIntentFile,
  NativeShareIntent, NativeShareIntentFile, ChangeEventPayload, ErrorEventPayload, StateEventPayload,
} from 'expo-share-intent/build/ExpoShareIntentModule.types.js';
export type { Parameters as ShareIntentPluginOptions, CustomParameter } from 'expo-share-intent/plugin/build/types.js';
import type { ShareIntent, AndroidShareIntent, AndroidShareIntentFile, ErrorEventPayload, StateEventPayload } from 'expo-share-intent/build/ExpoShareIntentModule.types.js';
import type { Parameters as ShareIntentPluginOptions } from 'expo-share-intent/plugin/build/types.js';

export type AppleTargetsPluginOptions = { appleTeamId?: string; match?: string; root?: string };
export type SharePluginOptions = { shareIntent?: ShareIntentPluginOptions; appleTargets?: AppleTargetsPluginOptions; desklink?: boolean };
export type ShareErrorCode = 'unreadable' | 'partial' | 'failed' | 'invalid_share_url';
export type ShareSkipReason = 'not_content' | 'own_provider' | 'too_large' | 'unreadable';
export type ShareIntentState = {
  isReady: boolean; hasShareIntent: boolean; shareIntent: ShareIntent;
  resetShareIntent: (clearNativeModule?: boolean) => void; error: string | null;
  errorCode: ShareErrorCode | null; skipped: number; skipReasons: readonly ShareSkipReason[];
};
export type ShareIntentModuleEvents = {
  onChange: (e: { value: string | AndroidShareIntent }) => void;
  onError: (e: ErrorEventPayload) => void;
  onStateChange: (e: StateEventPayload) => void;
};
export interface ShareIntentModuleLike {
  getShareIntent(url: string): Promise<void>;
  clearShareIntent(key: string): Promise<void>;
  hasShareIntent(key: string): boolean;
  addListener<E extends keyof ShareIntentModuleEvents>(event: E, listener: ShareIntentModuleEvents[E]): { remove(): void };
  removeListener<E extends keyof ShareIntentModuleEvents>(event: E, listener: ShareIntentModuleEvents[E]): void;
  removeAllListeners(event: keyof ShareIntentModuleEvents): void;
  emit<E extends keyof ShareIntentModuleEvents>(event: E, ...args: Parameters<ShareIntentModuleEvents[E]>): void;
  listenerCount<E extends keyof ShareIntentModuleEvents>(event: E): number;
}
export type NativeShareRead =
  | { kind: 'none'; seq: 0 }
  | { kind: 'unreadable'; seq: number; skipReasons: ShareSkipReason[] }
  | { kind: 'shared'; seq: number; text: string | null; title: string | null; files: AndroidShareIntentFile[]; skipReasons: ShareSkipReason[] };
export interface NativeShare {
  read(): Promise<NativeShareRead>;
  clear(seq: number): void;
  hasPending(): boolean;
  addListener(event: 'onShare', listener: () => void): { remove(): void };
}
