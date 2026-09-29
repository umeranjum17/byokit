// The device side (7.2): portable — browsers, React Native, Node; no node:* or Node-only imports may reach here
// (test/portable.test.ts guards it). Only type imports from @byokit/link; the seal crypto bundles cleanly.
import { boxKeyPairFromSeed } from '@byokit/seal';
import type { DeviceLink, LinkStream } from '@byokit/link';
import { toAccountView, type AccountView } from './words.ts';
import { b64urlEncode, openNotice } from './notices.ts';
import type {
  Approval,
  Decision,
  KitState,
  Route,
  RunEnd,
  RunEvent,
  SignInView,
} from './types.ts';

type EndFrame = { type: 'end'; end: RunEnd };

/**
 * The host ended a stream with its own words (e.g. a refusal). Portable twin of link's PublicLinkError:
 * same shape ({ code: 'failed', sealed: true }) so a screen can show .message the same way. A device-side
 * import of link's class would drag node:* into this portable entry (test/portable.test.ts).
 */
export class LinkRefused extends Error {
  readonly code = 'failed';
  readonly sealed = true;
  constructor(message: string) {
    super(message);
    this.name = 'LinkRefused';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Newline-delimited JSON frames off a link stream, in order. A host end with an error becomes a
 * LinkRefused with the host's words (a refusal arrives after the stream opens, so it cannot ride
 * the open itself).
 *
 * Plain manual iterables, deliberately not async generators: on this runtime a generator parked at
 * an await never settles a return() call, which would wedge teardown of an infinite stream. A plain
 * return() method always runs, ends the stream and wakes any parked next().
 */
function liveStream(open: () => Promise<LinkStream>): AsyncIterable<unknown> {
  let s: LinkStream | undefined;
  let opening: Promise<void> | undefined;
  let failed: unknown;
  let hasFailed = false;
  let ended = false;
  let endError: string | undefined;
  let closed = false;
  let text = '';
  const pending: string[] = [];
  const decoder = new TextDecoder();
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const ensure = (): Promise<void> => {
    opening ??= open().then(
      (stream) => {
        if (closed) {
          stream.end();
          return;
        }
        s = stream;
        stream.onData = (chunk) => {
          text += decoder.decode(chunk, { stream: true });
          let at = text.indexOf('\n');
          while (at >= 0) {
            pending.push(text.slice(0, at));
            text = text.slice(at + 1);
            at = text.indexOf('\n');
          }
          wake();
        };
        stream.onEnd = (error) => {
          ended = true;
          endError = error;
          wake();
        };
      },
      (error) => {
        failed = error;
        hasFailed = true;
        wake();
      },
    );
    return opening;
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          for (;;) {
            if (closed) return { value: undefined, done: true };
            while (pending.length) {
              const line = pending.shift()!;
              if (line) return { value: JSON.parse(line) as unknown, done: false };
            }
            if (hasFailed) throw failed;
            if (ended) {
              if (endError !== undefined) throw new LinkRefused(endError);
              return { value: undefined, done: true };
            }
            // Opening phase races the open against abandonment; once open, park only on the
            // waiters (re-racing a settled open would spin microtasks and starve the loop).
            if (s === undefined) {
              await Promise.race([ensure(), new Promise<void>((resolve) => {
                waiters.add(resolve);
              })]);
            } else {
              await new Promise<void>((resolve) => {
                waiters.add(resolve);
              });
            }
          }
        },
        async return(): Promise<IteratorResult<unknown>> {
          closed = true;
          s?.end();
          wake();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

export function openclawDevice(link: DeviceLink): {
  state(): Promise<{ state: KitState; words: string }>;
  routes(): Promise<Route[]>;
  signIn: {
    start(p: string, via: 'browser' | 'code'): Promise<SignInView>;
    view(p: string): Promise<AccountView>;
    paste(p: string, t: string): Promise<void>;
    cancel(p: string): Promise<void>;
  };
  run(message: string, o?: { sessionKey?: string }): AsyncIterable<RunEvent | { type: 'end'; end: RunEnd }>;
  steer(k: string, t: string): Promise<void>;
  abort(k: string): Promise<void>;
  approvals(): Promise<Approval[]>;
  decide(id: string, d: Decision): Promise<void>;
  events(): AsyncIterable<unknown>;
  registerNotices(seed: Uint8Array): Promise<void>; // derives the box key with @byokit/seal
  openNotice(data: Record<string, unknown>, seed: Uint8Array): Approval | null;
  call(method: string, params?: unknown): Promise<unknown>;
} {
  return {
    state: () => link.request('oc.state') as Promise<{ state: KitState; words: string }>,
    routes: () => link.request('oc.routes') as Promise<Route[]>,
    signIn: {
      start: (p, via) => link.request('oc.signin.start', { provider: p, via }) as Promise<SignInView>,
      view: async (p) => {
        const { ready, view } = (await link.request('oc.signin.view', { provider: p })) as {
          ready: boolean; view: SignInView | null;
        };
        return toAccountView(view, ready);
      },
      paste: async (p, t) => {
        await link.request('oc.signin.paste', { provider: p, text: t });
      },
      cancel: async (p) => {
        await link.request('oc.signin.cancel', { provider: p });
      },
    },
    run: (message, o) => {
      const inner = liveStream(() =>
        link.stream('oc.run', { message, ...(o?.sessionKey ? { sessionKey: o.sessionKey } : {}) }));
      let finished = false;
      return {
        [Symbol.asyncIterator]() {
          const it = inner[Symbol.asyncIterator]();
          return {
            next: async (): Promise<IteratorResult<RunEvent | EndFrame>> => {
              if (finished) return { value: undefined, done: true };
              const frame = await it.next();
              if (frame.done) return { value: undefined, done: true };
              if (isRecord(frame.value) && frame.value.type === 'end') {
                finished = true;
                await it.return?.();
                return { value: frame.value as EndFrame, done: false };
              }
              return { value: frame.value as RunEvent, done: false };
            },
            return: async (): Promise<IteratorResult<RunEvent | EndFrame>> => {
              finished = true;
              await it.return?.();
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
    steer: async (k, t) => {
      await link.request('oc.steer', { sessionKey: k, text: t });
    },
    abort: async (k) => {
      await link.request('oc.abort', { sessionKey: k });
    },
    approvals: () => link.request('oc.approvals') as Promise<Approval[]>,
    decide: async (id, d) => {
      await link.request('oc.decide', { id, ...d });
    },
    events: () => liveStream(() => link.stream('oc.events', {})),
    registerNotices: async (seed) => {
      if (!ArrayBuffer.isView(seed) || !(seed instanceof Uint8Array) || seed.length !== 32)
        throw new Error('registerNotices needs a 32-byte seed');
      await link.request('oc.notices.register', { boxPublicKey: b64urlEncode(boxKeyPairFromSeed(seed).publicKey) });
    },
    openNotice,
    call: (method, params) => link.request('oc.call', { method, params }) as Promise<unknown>,
  };
}

// Portable, re-exported by ./device (7.3).
export { openNotice } from './notices.ts';
