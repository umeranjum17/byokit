import WORDS from './words.json' with { type: 'json' };
import { createServer } from 'node:http';
import { connect, type Connection } from './connect.ts';
import { ConnectError } from './errors.ts';
import type { ConnectOptions, Provider } from './types.ts';
import type { ProviderId } from './providers.ts';
export interface LoopbackOptions extends Omit<ConnectOptions, 'redirectUri'> {
  /** Host opens the browser; BYOKit never spawns the person's browser or CLI. */
  open(url: string): Promise<void> | void;
}
/** One-shot loopback listener on an OS-assigned port; closes on completion, cancel or timeout. */
export async function connectLoopback(target: ProviderId | Provider | string, options: LoopbackOptions): Promise<{ connection: Connection; done: Promise<void>; cancel(): void }> {
  let finish: ((callback: string) => Promise<void>) | undefined;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // The caller receives the promise after browser opening; a timeout before then is still handled.
  void done.catch(() => {});
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (error?: unknown) => {
    if (settled) return; settled = true; clearTimeout(timer);
    server.close(); server.closeAllConnections();
    if (error) { cancelFlow?.(); reject(error); } else resolve();
  };
  let origin = '';
  let state: string | undefined;
  let completing = false;
  let cancelFlow: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    if (req.method !== 'GET' || req.headers.host !== new URL(origin).host || req.url?.split('?')[0] !== '/callback' || !finish || settled) { res.writeHead(404); res.end(WORDS.browser.unavailable); return; }
    const callback = new URL(req.url, origin);
    if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state) { res.writeHead(400); res.end(WORDS.browser.mismatch); return; }
    if (completing) { res.writeHead(409); res.end(WORDS.browser.finishing); return; }
    completing = true;
    try { await finish(callback.href); res.end(WORDS.browser.connected); setImmediate(() => settle()); }
    catch (error) {
      res.writeHead(400); res.end(WORDS.browser.failed);
      setImmediate(() => settle(error));
    }
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => { server.removeListener('error', no); yes(); }); });
  server.on('error', error => settle(error));
  const address = server.address();
  if (!address || typeof address === 'string') { settle(new ConnectError('configuration')); throw new ConnectError('configuration'); }
  origin = `http://127.0.0.1:${address.port}`;
  timer = setTimeout(() => settle(new ConnectError('expired')), options.flowTimeoutMs ?? 15 * 60_000);
  try {
    const connection = connect(target, { ...options, redirectUri: `${origin}/callback` });
    const flow = await connection.signIn(); state = new URL(flow.url).searchParams.get('state')!; finish = callback => flow.finish(callback); cancelFlow = flow.cancel;
    if (settled) throw new ConnectError('expired');
    await options.open(flow.url);
    return { connection, done, cancel: () => { cancelFlow?.(); settle(new ConnectError('declined')); } };
  } catch (error) { cancelFlow?.(); settle(error); throw error; }
}
