export { createNotices, openNoticeContent } from './notices.ts';
export type { NoticeContent, NativeNotices } from './notices.ts';
export { sealAnswer, openAnswer, openChoice } from './answer.ts';
export type { NoticeAnswer, AnswerTarget, AnswerReply } from './answer.ts';
import { createNotices } from './notices.ts';
export const { setNoticeKey, clearNoticeKey, setAnswerTargets } = createNotices(null);
