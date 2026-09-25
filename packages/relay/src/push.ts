// Push notifications, so a sleeping phone hears from its host. Subscriptions (Expo tokens and Web Push) belong to a
// host and one of its devices; the host adds and removes them over its relay socket, because only the host knows which
// devices it has. What a notification says is up to the host, and the relay, Expo and the browser's push service all
// read it: keep it generic ("An agent needs you") and let the device fetch details over the link.
import { isIP } from 'node:net';
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

/** A push subscription's endpoint must be a public https push service with no credentials in it (or plain http to
 *  loopback, for local stubs): a subscription must never point the relay at an internal address. */
export function isAllowedEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 2048) return false;
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.username || u.password || !u.hostname || /\s/.test(u.hostname)) return false;
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:') return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  return u.protocol === 'https:' && !internal(host);
}

const INTERNAL = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.private', '.test', '.example', '.invalid'];

function internal(host: string): boolean {
  const name = host.replace(/\.$/, '');
  const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
  if (isIP(bare)) return !publicIp(bare);
  return bare === 'localhost' || !bare.includes('.') || INTERNAL.some((s) => bare.endsWith(s));
}

// URL parsing has already normalised every spelling of an IPv4-mapped IPv6 address to ::ffff:xxxx:xxxx.
function mapped(v6: string): string | undefined {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  return m ? [...m[1]!.padStart(4, '0').match(/../g)!, ...m[2]!.padStart(4, '0').match(/../g)!].map((h) => parseInt(h, 16)).join('.') : undefined;
}

function publicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || (a === 100 && b >= 64 && b <= 127));
  }
  const v6 = ip.toLowerCase();
  const v4 = mapped(v6);
  if (v4 !== undefined) return publicIp(v4);
  return !v6.startsWith('::') && !(/^fe[89ab]/.test(v6) || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('ff'));
}

/** A subscription as a host sent it, checked; undefined if it is not one. */
export function parseSubscription(s: any): Subscription | undefined {
  if (isExpoToken(s?.expo)) return { expo: s.expo };
  const w = s?.web;
  if (isAllowedEndpoint(w?.endpoint) && text(w?.keys?.p256dh, 256) && text(w?.keys?.auth, 256)) {
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
  subs: PushRecord[]; n: Notification; action: Map<string, string>; vapid: Vapid; subject: string; fetch: typeof fetch;
}): Promise<{ sent: number; gone: PushRecord[] }> {
  const { n } = o;
  const ttl = n.ttl ?? 86_400;
  const payload = (device: string) => ({
    id: n.id, title: n.title, body: n.body, ...(n.data && { data: n.data }),
    ...(o.action.has(device) && { actions: n.actions, action: o.action.get(device) }),
  });
  const web = o.subs.filter((s): s is PushRecord & { web: WebSubscription } => 'web' in s);
  const expo = o.subs.filter((s): s is PushRecord & { expo: string } => 'expo' in s);
  const gone: PushRecord[] = [];
  let sent = 0;
  await Promise.all(web.map(async (s) => {
    try {
      const r = webpush.generateRequestDetails(s.web, JSON.stringify(payload(s.device)), {
        vapidDetails: { subject: o.subject, publicKey: o.vapid.publicKey, privateKey: o.vapid.privateKey }, TTL: ttl, urgency: n.urgency ?? 'normal',
      });
      const res = await o.fetch(r.endpoint, { method: 'POST', headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, String(v)])), body: r.body as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(5000) });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 410) gone.push(s);
    } catch {} // a push service that is down loses this one notification, never the subscription
  }));
  if (expo.length) {
    try {
      const res = await o.fetch(EXPO_SEND, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(5000),
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
