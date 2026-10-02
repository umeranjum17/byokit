// The device side (7.2): portable — browsers, React Native, Node; no node:* or Node-only imports may reach here
// (test/portable.test.ts guards it). Only type imports from @byokit/link; the seal crypto bundles cleanly.
import { boxKeyPairFromSeed } from '@byokit/seal';
import type { DeviceLink, LinkStream } from '@byokit/link';
import type { RouteView } from './routes.ts';
import { toAccountView, type AccountView } from './words.ts';
import { b64urlEncode, openNotice } from './notices.ts';
import type {
  Approval,
  Decision,
  GatewayEventName,
  GatewayEventPayload,
  GatewayMethod,
  GatewayParams,
  GatewayResult,
  KitState,
  Route,
  RunEnd,
  OutputSchema,
  SchemaOutput,
  RunEvent,
  SignInView,
} from './types.ts';

export type { GatewayEventName, GatewayEventPayload, GatewayMethod, GatewayParams, GatewayResult } from './types.ts';
export type { Approval, Decision, KitState, PlanWindow, Route, RunEnd, RunEvent, RunUsage, SignInView, OutputSchema, SchemaOutput } from './types.ts';

/** One `oc.events` frame: a member's Gateway event, typed by name, or an approval add/resolve (7.2). */
export type OpenClawLinkEvent =
  | { [E in GatewayEventName]: { event: E; payload: GatewayEventPayload<E> } }[GatewayEventName]
  | { event: 'approval'; change: 'added' | 'resolved'; approval: Approval };

/** One `oc.sessions` row: `sessions.list` filtered to the member's `agent:<member>:` keys. */
export type SessionRow = { sessionKey: string; [k: string]: unknown };

type EndFrame<T = unknown> = { type: 'end'; end: RunEnd<T> };

/** `oc.run`'s options beside the message: the member's own session, account, and the kit's run options. */
export type DeviceRunOptions<S extends OutputSchema | undefined = OutputSchema | undefined> = {
  schema?: S;
  sessionKey?: string;
  model?: string; // 'provider/model'
  auth?: 'apiKey';
  system?: string;
  images?: { data: string; mimeType: string }[]; // base64 data
  thinking?: 'off' | 'low' | 'medium' | 'high';
  tools?: string[]; // a subset of the computer's app tools; a name it does not register is refused
};

/** `oc.state`: the engine phase and words, this kit's and the engine's versions, and the device member's sign-ins. */
export type DeviceState = {
  state: KitState;
  words: string;
  version: string; // @byokit/openclaw on the computer
  engine: string; // the pinned OpenClaw engine version
  signedIn?: string[]; // provider ids the member is signed in to; absent while the engine can't say
};

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
  state(): Promise<DeviceState>;
  routes(): Promise<RouteView[]>;
  signIn: {
    start(p: string, via: 'browser' | 'code'): Promise<SignInView>;
    view(p: string): Promise<AccountView>;
    paste(p: string, t: string): Promise<void>;
    cancel(p: string): Promise<void>;
  };
  signOut(p: string): Promise<void>;
  sessions(): Promise<SessionRow[]>;
  run<const S extends OutputSchema | undefined = undefined>(message: string, o?: DeviceRunOptions<S>): AsyncIterable<RunEvent | EndFrame<SchemaOutput<S>>>;
  steer(k: string, t: string, o?: { auth?: 'apiKey' }): Promise<void>;
  abort(k: string, o?: { auth?: 'apiKey' }): Promise<void>;
  approvals(): Promise<Approval[]>;
  decide(id: string, d: Decision): Promise<void>;
  events(): AsyncIterable<OpenClawLinkEvent>;
  registerNotices(seed: Uint8Array): Promise<void>; // derives the box key with @byokit/seal
  openNotice(data: Record<string, unknown>, seed: Uint8Array): Approval | null;
  call<M extends GatewayMethod>(method: M, params: GatewayParams<M>): Promise<GatewayResult<M>>;
} {
  return {
    state: () => link.request('oc.state') as Promise<DeviceState>,
    routes: () => link.request('oc.routes') as Promise<RouteView[]>,
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
    signOut: async (p) => {
      await link.request('oc.signout', { provider: p });
    },
    sessions: () => link.request('oc.sessions') as Promise<SessionRow[]>,
    run: <const S extends OutputSchema | undefined = undefined>(message: string, o?: DeviceRunOptions<S>) => {
      const inner = liveStream(() =>
        link.stream('oc.run', { message, ...(o?.sessionKey ? { sessionKey: o.sessionKey } : {}),
          ...(o?.model !== undefined ? { model: o.model } : {}), ...(o?.system !== undefined ? { system: o.system } : {}),
          ...(o?.auth !== undefined ? { auth: o.auth } : {}),
          ...(o?.images !== undefined ? { images: o.images } : {}), ...(o?.thinking !== undefined ? { thinking: o.thinking } : {}),
          ...(o?.tools !== undefined ? { tools: o.tools } : {}), ...(o?.schema !== undefined ? { schema: o.schema } : {}) }));
      let finished = false;
      return {
        [Symbol.asyncIterator]() {
          const it = inner[Symbol.asyncIterator]();
          return {
            next: async (): Promise<IteratorResult<RunEvent | EndFrame<SchemaOutput<S>>>> => {
              if (finished) return { value: undefined, done: true };
              const frame = await it.next();
              if (frame.done) return { value: undefined, done: true };
              if (isRecord(frame.value) && frame.value.type === 'end') {
                finished = true;
                await it.return?.();
                return { value: frame.value as EndFrame<SchemaOutput<S>>, done: false };
              }
              return { value: frame.value as RunEvent, done: false };
            },
            return: async (): Promise<IteratorResult<RunEvent | EndFrame<SchemaOutput<S>>>> => {
              finished = true;
              await it.return?.();
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
    steer: async (k, t, o) => {
      await link.request('oc.steer', { sessionKey: k, text: t, ...(o?.auth ? { auth: o.auth } : {}) });
    },
    abort: async (k, o) => {
      await link.request('oc.abort', { sessionKey: k, ...(o?.auth ? { auth: o.auth } : {}) });
    },
    approvals: () => link.request('oc.approvals') as Promise<Approval[]>,
    decide: async (id, d) => {
      await link.request('oc.decide', { id, ...d });
    },
    events: () => liveStream(() => link.stream('oc.events', {})) as AsyncIterable<OpenClawLinkEvent>,
    registerNotices: async (seed) => {
      if (!ArrayBuffer.isView(seed) || !(seed instanceof Uint8Array) || seed.length !== 32)
        throw new Error('registerNotices needs a 32-byte seed');
      await link.request('oc.notices.register', { boxPublicKey: b64urlEncode(boxKeyPairFromSeed(seed).publicKey) });
    },
    openNotice,
    call: <M extends GatewayMethod>(method: M, params: GatewayParams<M>) =>
      link.request('oc.call', { method, params }) as Promise<GatewayResult<M>>,
  };
}

// Portable, re-exported by ./device (7.3).
export { openNotice } from './notices.ts';
export { readAgentUsage, agentUsageOf } from './usage.ts';
export type { AgentUsageReading, LedgerUsageTotals, UsageCache, UsageWindow } from './usage.ts';
// The kit's sentences, so a phone or browser shows the same words the computer does (5.14).
export { stateWords, toAccountView, words, type AccountView, type WordKey } from './words.ts';
