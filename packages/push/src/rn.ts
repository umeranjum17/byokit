import { requireOptionalNativeModule } from 'expo-modules-core';
import { createNotices } from './notices.ts';
import type { NativeNotices } from './notices.ts';
export { createNotices, openNoticeContent } from './notices.ts';
export type { NoticeContent, NativeNotices } from './notices.ts';
export { sealAnswer, openAnswer } from './answer.ts';
export type { NoticeAnswer, AnswerTarget, AnswerReply } from './answer.ts';
export const { setNoticeKey, clearNoticeKey, setAnswerTargets } = createNotices(requireOptionalNativeModule<NativeNotices>('ByokitNotices'));
