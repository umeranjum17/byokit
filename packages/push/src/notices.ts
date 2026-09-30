import { openNotice } from '@byokit/seal';

export type NoticeContent = { title: string; body: string; data?: Record<string, unknown> };
export interface NativeNotices {
  setNoticeKey(key: number[]): Promise<void>;
  clearNoticeKey(): Promise<void>;
}
/** Accept the seal envelope itself, or the `notice` field of APNs/FCM custom data. */
export function openNoticeContent(payload: unknown, key: Uint8Array): NoticeContent | null {
  try {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const fields = payload as Record<string, unknown>;
    const expo = typeof fields.body === 'object' && fields.body !== null ? fields.body as Record<string, unknown> : {};
    const envelope = fields.notice ?? expo.notice ?? payload;
    const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.sealed !== 'string' || parsed.sealed.length > 8192) return null;
    const value = openNotice(parsed, key);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const content = value as Record<string, unknown>;
    if (typeof content.title !== 'string' || content.title.length === 0 || typeof content.body !== 'string') return null;
    if (content.data !== undefined && (typeof content.data !== 'object' || content.data === null || Array.isArray(content.data))) return null;
    return { title: content.title, body: content.body, ...(content.data === undefined ? {} : { data: content.data as Record<string, unknown> }) };
  } catch { return null; }
}
export function createNotices(native: NativeNotices | null) {
  return {
    async setNoticeKey(key: Uint8Array): Promise<void> {
      if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('notices: key must be 32 bytes');
      if (native === null) throw new Error('notices: unavailable on this platform');
      await native.setNoticeKey(Array.from(key));
    },
    async clearNoticeKey(): Promise<void> {
      if (native === null) throw new Error('notices: unavailable on this platform');
      await native.clearNoticeKey();
    },
  };
}
