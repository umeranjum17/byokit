// Push notifications, so a sleeping phone hears from its host. Subscriptions (Expo tokens and Web Push) belong to a
// host and one of its devices; the host adds and removes them over its relay socket, because only the host knows which
// devices it has. What a notification says is up to the host, and the relay, Expo and the browser's push service all
// read it: keep it generic ("An agent needs you") and let the device fetch details over the link.
import webpush from 'web-push';

export type WebSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
/** A device's push address: an Expo push token, or a browser's Web Push subscription. */
export type Subscription = { expo: string } | { web: WebSubscription };
export type Vapid = { publicKey: string; privateKey: string };
/** What a host sends. `to` picks devices (grant ids); default every device with a subscription. `actions` are the
 *  buttons the device may show; pressing one reaches the host's `onAction` through the relay. */
export type Notification = {
  id: string; title: string; body: string; data?: Record<string, unknown>;
  to?: string[]; actions?: string[]; urgency?: 'very-low' | 'low' | 'normal' | 'high'; ttl?: number;
};
/** One stored subscription. */
export type PushRecord = { host: string; device: string; added: number } & Subscription;

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
  if (isExpoToken(s?.expo)) return { expo: s.expo };
  const w = s?.web;
  if (isAllowedEndpoint(w?.endpoint, hosts) && text(w?.keys?.p256dh, 256) && text(w?.keys?.auth, 256)) {
    return { web: { endpoint: w.endpoint, keys: { p256dh: w.keys.p256dh, auth: w.keys.auth } } };
  }
  return undefined;
}

/** A notification as a host sent it, checked; undefined if it is not one. */
export function parseNotification(n: any): Notification | undefined {
  if (!(typeof n?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(n.id) && text(n.title, 120) && text(n.body, 400))) return undefined;
  if (n.data !== undefined && (typeof n.data !== 'object' || n.data === null || Array.isArray(n.data) || JSON.stringify(n.data).length > 2048)) return undefined;
  if (n.to !== undefined && !(Array.isArray(n.to) && n.to.length <= 256 && n.to.every((d: unknown) => text(d, 128)))) return undefined;
  if (n.actions !== undefined && !(Array.isArray(n.actions) && n.actions.length <= 4 && n.actions.every((a: unknown) => text(a, 32)))) return undefined;
  if (n.urgency !== undefined && !['very-low', 'low', 'normal', 'high'].includes(n.urgency)) return undefined;
  if (n.ttl !== undefined && !(Number.isInteger(n.ttl) && n.ttl >= 0 && n.ttl <= 28 * 86_400)) return undefined;
  const { id, title, body, data, to, actions, urgency, ttl } = n;
  return { id, title, body, ...(data && { data }), ...(to && { to }), ...(actions && { actions }), ...(urgency && { urgency }), ...(ttl !== undefined && { ttl }) };
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
    id: n.id, title: n.title, body: n.body, ...(n.data && { data: n.data }),
    ...(o.action.has(device) && { actions: n.actions, action: o.action.get(device) }),
  });
  const gone = o.subs.filter((s) => !parseSubscription(s, o.hosts));
  const web = o.subs.filter((s): s is PushRecord & { web: WebSubscription } => 'web' in s && !gone.includes(s));
  const expo = o.subs.filter((s): s is PushRecord & { expo: string } => 'expo' in s && !gone.includes(s));
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
        body: JSON.stringify(expo.map((s) => ({
          to: s.expo, title: n.title, body: n.body, sound: 'default', collapseId: n.id, ttl,
          priority: n.urgency === 'high' ? 'high' : 'normal', data: payload(s.device),
        }))),
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
