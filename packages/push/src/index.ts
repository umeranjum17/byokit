export { createNotices, openNoticeContent } from './notices.ts';
export type { NoticeContent, NativeNotices } from './notices.ts';
import { createNotices } from './notices.ts';
export const { setNoticeKey, clearNoticeKey } = createNotices(null);
