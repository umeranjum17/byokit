import { requireOptionalNativeModule } from 'expo-modules-core';
import { createNotices } from './notices.ts';
import type { NativeNotices } from './notices.ts';
export { createNotices, openNoticeContent } from './notices.ts';
export type { NoticeContent, NativeNotices } from './notices.ts';
export const { setNoticeKey, clearNoticeKey } = createNotices(requireOptionalNativeModule<NativeNotices>('ByokitNotices'));
