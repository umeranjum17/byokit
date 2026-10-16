// The device's side, for typed pairing through a relay: turn the short code the host showed into the address to dial.
// No Node APIs, so it runs in browsers and React Native too.
import { RelayLookupError, type RelayLookupErrorCode } from './words.ts';
export { RelayLookupError, type RelayLookupErrorCode };
export { readJobStream, MAX_JOB_FRAME_BYTES, type JobPart, type JobFrame, type JobCursor } from './jobs.ts';

/** How long a host lookup waits for the relay before it gives up. The lookup is the step right before link dials the
 *  host with the same 8 s bound (`@byokit/pair`'s `Dial.timeoutMs`, and its `check` probe), so a phone gives each step
 *  of pairing the same budget; the relay's own outbound HTTP calls use 5 s. */
export const RELAY_LOOKUP_MS = 8000;

/** The link address for an already-known host id (not its public key). */
export function linkUrl(relay: string, hostId: string): string {
  const base = new URL(relay);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(base.protocol)) throw new Error('Use an HTTP or WebSocket relay address.');
  if (!/^[A-Za-z0-9_-]{22}$/.test(hostId)) throw new Error('That host address is invalid.');
  const secure = base.protocol === 'https:' || base.protocol === 'wss:';
  return `${secure ? 'wss' : 'ws'}://${base.host}/link/v1/${hostId}`;
}

/** The link address for a short code from `RelayClient.code()`, e.g. `findHost('https://relay.example', 'K7M2QX')` →
 *  `wss://relay.example/link/v1/<host id>`. Pass it to link's `pairWithCode` with the pairing code.
 *
 *  The lookup is bounded: a relay that accepts the request but never answers (a dropped connection) rejects with
 *  `RelayLookupError` `timeout` after `timeoutMs` (default {@link RELAY_LOOKUP_MS}) instead of hanging, and the
 *  request is aborted so its socket is torn down. */
export async function findHost(relay: string, code: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string> {
  const base = new URL(relay);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new RelayLookupError('timeout')); }, o.timeoutMs ?? RELAY_LOOKUP_MS);
  });
  try {
    const res = await Promise.race([
      (o.fetch ?? fetch)(new URL(`/relay/v1/codes/${encodeURIComponent(code.trim())}`, base), { signal: controller.signal }),
      deadline,
    ]);
    if (res.status === 404) throw new RelayLookupError('wrong-code');
    if (!res.ok) throw new RelayLookupError('unreachable');
    const { host } = await Promise.race([res.json() as Promise<{ host?: unknown }>, deadline]);
    if (typeof host !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(host)) throw new RelayLookupError('unreachable');
    return linkUrl(relay, host);
  } finally {
    clearTimeout(timer);
  }
}
