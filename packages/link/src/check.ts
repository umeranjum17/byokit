// A per-URL reachability probe for onboarding: before pairing, the phone checks the offer's URLs (and the host
// checks its own advertised URL) without claiming or burning the one-time offer. No platform APIs: the same code
// runs in Node, browsers and React Native on the platform WebSocket, like `dial` in device.ts.
import { LINK_WORDS, type LinkProblem } from './device.ts';

/** The first frame a probe sends. The host answers with LINK_PROBE_OK and closes; it touches no ticket, code,
// grant or counter, so a checked offer still pairs afterwards. Relayed devices speak bare frames, so the same
// exchange works through a relay with no relay change. */
export const LINK_PROBE = 'byokit-link-probe-v1';
export const LINK_PROBE_OK = 'byokit-link-probe-v1:ok';

export type CheckResult =
  | { url: string; ok: true }
  | { url: string; ok: false; code: LinkProblem; message: string };

export type CheckOptions = {
  /** Each URL gets this long (default 8000, like pairing). */
  timeoutMs?: number;
  /** How many URLs to probe at once (default 4). */
  concurrency?: number;
  /** Override the WebSocket (tests, or a platform without a global). */
  WebSocket?: new (url: string) => {
    send(data: string): void; close(code?: number, reason?: string): void;
    onopen: unknown; onmessage: unknown; onclose: unknown; onerror: unknown;
  };
};

const fail = (url: string, code: LinkProblem): CheckResult => ({ url, ok: false, code, message: LINK_WORDS[code] });

function probe(url: string, o: CheckOptions, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    let ws: any;
    let done = false;
    let opened = false;
    const finish = (r: CheckResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish(fail(url, opened ? 'timeout' : 'unreachable')), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      const WS = o.WebSocket ?? (globalThis as any).WebSocket;
      ws = new WS(url);
    } catch {
      return finish(fail(url, 'unreachable'));
    }
    try { ws.binaryType = 'arraybuffer'; } catch {}
    ws.onopen = () => { opened = true; try { ws.send(LINK_PROBE); } catch { finish(fail(url, 'unreachable')); } };
    ws.onerror = () => finish(fail(url, 'unreachable'));
    ws.onmessage = (ev: any) => {
      const data = typeof ev?.data === 'string' ? ev.data : null;
      finish(data === LINK_PROBE_OK ? { url, ok: true } : fail(url, 'wrong-host'));
    };
    ws.onclose = (e: any) => {
      // A host from before the probe route still proves it is there by rejecting the probe as a bad handshake.
      if (!done) finish(e?.code === 4400 ? { url, ok: true } : fail(url, opened ? 'wrong-host' : 'unreachable'));
    };
  });
}

/** Probe each URL for a link host, in input order. Only `unreachable` (nothing there), `timeout` (something there
 *  that never answered) and `wrong-host` (something else answered) can come back, each with its LINK_WORDS sentence;
 *  no new codes were needed. Never sends a ticket, so offers stay usable. */
export async function check(urls: string[], o: CheckOptions = {}): Promise<CheckResult[]> {
  const timeoutMs = o.timeoutMs ?? 8000;
  const out: CheckResult[] = new Array(urls.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, o.concurrency ?? 4), urls.length) }, async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = await probe(urls[i]!, o, timeoutMs);
    }
  }));
  return out;
}
