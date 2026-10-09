// Push notifications, so a sleeping phone hears from its host. Subscriptions (Expo tokens and Web Push) belong to a
// host and one of its devices; the host adds and removes them over its relay socket, because only the host knows which
// devices it has. The relay reads notification text before Web Push encryption; Expo and its delivery providers can
// also read Expo notification text. Keep it generic and let the device fetch details over the link.
import webpush from 'web-push';

export type WebSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
/** A device's push address: an Expo push token, or a browser's Web Push subscription. `platform` is the device's
 *  own report of its OS (React Native `Platform.OS`); only an `'android'` token can get a data-only message. */
export type Subscription = { expo: string; platform?: 'ios' | 'android' } | { web: WebSubscription };
export type Vapid = { publicKey: string; privateKey: string };
/** What a host sends. `to` picks devices (grant ids); default every device with a subscription. `actions` are the
 *  buttons the device may show; pressing one reaches the host's `onAction` through the relay. */
export type Notification = {
  id: string; title: string; body?: string; data?: Record<string, unknown>;
  to?: string[]; actions?: string[]; urgency?: 'very-low' | 'low' | 'normal' | 'high'; ttl?: number;
  /** Expo, iOS: APNs `mutable-content`, so the app's Notification Service Extension may replace the visible text
   *  (for example with a notice it opens from `data`) before it shows. Without an extension, the alert shows as sent. */
  mutableContent?: boolean;
  /** Expo, iOS and Android: the notification category the app registered, whose buttons the alert shows. */
  categoryId?: string;
  /** Expo, Android: tokens subscribed with `platform: 'android'` get a data-only message (no title, body, sound or
   *  category) for the app to present itself; other subscriptions get the visible alert. Android may delay it (Doze)
   *  and does not deliver it to a force-stopped app; use `urgency: 'high'` for prompt delivery. */
  dataOnly?: boolean;
};
/** One stored subscription. */
export type PushRecord = { host: string; device: string; added: number } & Subscription;

/** The most UTF-8 bytes a sealed `reply` may carry, matching the native sealed-notice envelope cap. The relay
 *  forwards the string unchanged and never parses it. */
export const MAX_ACTION_REPLY = 8192;
/** A reply the relay will carry: a non-empty string within `MAX_ACTION_REPLY` bytes, otherwise refused. The relay only
 *  bounds its size; it never reads the ciphertext. */
export const isActionReply = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_ACTION_REPLY;

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
const UNSAFE = /[\u0000-\u001f\u007f]/;
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !UNSAFE.test(v);

export const isExpoToken = (v: unknown): v is string => typeof v === 'string' && v.length <= 256 && /^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/.test(v);

export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', '*.push.apple.com', 'updates.push.services.mozilla.com', '*.notify.windows.com'] as const;

const matches = (host: string, pattern: string) => pattern.startsWith('*.')
  ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
  : host === pattern;

export function pushHosts(hosts?: readonly string[]): readonly string[] {
  if (!hosts) return DEFAULT_PUSH_HOSTS;
  if (hosts.some((host) => typeof host !== 'string' || !DEFAULT_PUSH_HOSTS.some((pattern) =>
    host === pattern || (!host.includes('*') && matches(host, pattern))))) throw new Error('push host outside default allowlist');
  return [...hosts];
}

/** A push subscription's endpoint must belong to an approved HTTPS push service. */
export function isAllowedEndpoint(value: unknown, hosts: readonly string[] = DEFAULT_PUSH_HOSTS): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 2048) return false;
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && !u.port
    && hosts.some((pattern) => matches(u.hostname, pattern));
}

/** A subscription as a host sent it, checked; undefined if it is not one. */
export function parseSubscription(s: any, hosts?: readonly string[]): Subscription | undefined {
  if (!s || typeof s !== 'object' || ('expo' in s) === ('web' in s)) return undefined;
  if ('expo' in s) {
    if (!isExpoToken(s.expo) || ![undefined, 'ios', 'android'].includes(s.platform)) return undefined;
    return { expo: s.expo, ...(s.platform && { platform: s.platform }) };
  }
  const w = s.web;
  if (isAllowedEndpoint(w?.endpoint, hosts) && text(w?.keys?.p256dh, 256) && text(w?.keys?.auth, 256)) {
    return { web: { endpoint: w.endpoint, keys: { p256dh: w.keys.p256dh, auth: w.keys.auth } } };
  }
  return undefined;
}

/** A notification as a host sent it, checked; undefined if it is not one. */
export function parseNotification(n: any): Notification | undefined {
  if (!(typeof n?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(n.id) && text(n.title, 120))) return undefined;
  if (n.body !== undefined && !text(n.body, 400)) return undefined;
  if (n.data !== undefined && (typeof n.data !== 'object' || n.data === null || Array.isArray(n.data) || JSON.stringify(n.data).length > 2048)) return undefined;
  if (n.to !== undefined && !(Array.isArray(n.to) && n.to.length <= 256 && n.to.every((d: unknown) => text(d, 128)))) return undefined;
  if (n.actions !== undefined && !(Array.isArray(n.actions) && n.actions.length <= 4 && n.actions.every((a: unknown) => text(a, 32)))) return undefined;
  if (n.urgency !== undefined && !['very-low', 'low', 'normal', 'high'].includes(n.urgency)) return undefined;
  if (n.ttl !== undefined && !(Number.isInteger(n.ttl) && n.ttl >= 0 && n.ttl <= 28 * 86_400)) return undefined;
  if (n.mutableContent !== undefined && typeof n.mutableContent !== 'boolean') return undefined;
  if (n.categoryId !== undefined && !(typeof n.categoryId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(n.categoryId))) return undefined;
  if (n.dataOnly !== undefined && typeof n.dataOnly !== 'boolean') return undefined;
  const { id, title, body, data, to, actions, urgency, ttl, mutableContent, categoryId, dataOnly } = n;
  return { id, title, ...(body !== undefined && { body }), ...(data && { data }), ...(to && { to }), ...(actions && { actions }), ...(urgency && { urgency }), ...(ttl !== undefined && { ttl }),
    ...(mutableContent !== undefined && { mutableContent }), ...(categoryId && { categoryId }), ...(dataOnly !== undefined && { dataOnly }) };
}

export const vapidKeys = (): Vapid => webpush.generateVAPIDKeys();

/** Sends one notification to each subscription. `action` holds each device's one-use action token. Returns how many
 *  were accepted and which subscriptions the push service says are gone for good. */
export async function deliver(o: {
  subs: PushRecord[]; n: Notification; action: Map<string, string>; vapid: Vapid; subject: string; fetch: typeof fetch; hosts: readonly string[];
}): Promise<{ sent: number; gone: PushRecord[] }> {
  const { n } = o;
  const ttl = n.ttl ?? 86_400;
  const payload = (device: string) => ({
    id: n.id, title: n.title, ...(n.body !== undefined && { body: n.body }), ...(n.data && { data: n.data }),
    ...(o.action.has(device) && { actions: n.actions, action: o.action.get(device) }),
  });
  const gone = o.subs.filter((s) => !parseSubscription(s, o.hosts));
  const web = o.subs.filter((s): s is PushRecord & { web: WebSubscription } => 'web' in s && !gone.includes(s));
  const expo = o.subs.filter((s): s is PushRecord & Extract<Subscription, { expo: string }> => 'expo' in s && !gone.includes(s));
  let sent = 0;
  await Promise.all(web.map(async (s) => {
    try {
      const r = webpush.generateRequestDetails(s.web, JSON.stringify(payload(s.device)), {
        vapidDetails: { subject: o.subject, publicKey: o.vapid.publicKey, privateKey: o.vapid.privateKey }, TTL: ttl, urgency: n.urgency ?? 'normal',
      });
      const res = await o.fetch(r.endpoint, { method: 'POST', headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, String(v)])), body: r.body as Uint8Array<ArrayBuffer>, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 410) gone.push(s);
    } catch {} // a push service that is down loses this one notification, never the subscription
  }));
  if (expo.length) {
    try {
      const res = await o.fetch(EXPO_SEND, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
        body: JSON.stringify(expo.map((s) => {
          const delivery = { to: s.expo, collapseId: n.id, ttl, priority: n.urgency === 'high' ? 'high' : 'normal', data: payload(s.device) };
          // Expo sends a message with no title or body to Android as an FCM data message, which the app presents itself.
          if (n.dataOnly && s.platform === 'android') return delivery;
          return { ...delivery, title: n.title, ...(n.body !== undefined && { body: n.body }), sound: 'default',
            ...(n.mutableContent !== undefined && { mutableContent: n.mutableContent }), ...(n.categoryId && { categoryId: n.categoryId }) };
        })),
      });
      const tickets: any[] = res.ok ? ((await res.json()) as any)?.data ?? [] : [];
      tickets.forEach((t, i) => {
        if (t?.status === 'ok') sent++;
        else if (t?.details?.error === 'DeviceNotRegistered' && expo[i]) gone.push(expo[i]);
      });
    } catch {}
  }
  return { sent, gone };
}
