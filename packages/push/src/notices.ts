import { openNotice } from '@byokit/seal';
import { validTarget, type AnswerTarget } from './answer.ts';

export type NoticeContent = { title: string; body: string; data?: Record<string, unknown> };
export interface NativeNotices {
  setNoticeKey(key: number[]): Promise<void>;
  clearNoticeKey(): Promise<void>;
  setAnswerTargets(targets: { host: string; relay: string; key: number[] }[]): Promise<void>;
}
/** Accept the seal envelope itself, the `notice` field of APNs/FCM custom data, or `@byokit/relay`'s `data`. */
export function openNoticeContent(payload: unknown, key: Uint8Array): NoticeContent | null {
  try {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const fields = payload as Record<string, unknown>;
    const expo = typeof fields.body === 'object' && fields.body !== null ? fields.body as Record<string, unknown> : {};
    const envelope = fields.notice ?? expo.notice ?? expo.data ?? payload;
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
    /** Replaces every Answer target; `[]` clears them. Call again when pairing adds or revokes a host. */
    async setAnswerTargets(targets: AnswerTarget[]): Promise<void> {
      const bad = targets.find((target) => !validTarget(target));
      if (bad !== undefined) throw new Error(`notices: answer target ${JSON.stringify(String(bad.host))} needs a host id, an https relay origin and a 32-byte key`);
      if (native === null) throw new Error('notices: unavailable on this platform');
      await native.setAnswerTargets(targets.map(({ host, relay, key }) => ({ host, relay: relay.replace(/\/$/, ''), key: Array.from(key) })));
    },
  };
}
