// The phone and browser side (portable: no Node import anywhere in it): typed calls to a host running this kit's
// link adapter (docs/runtime-kits.md 7.2).
import type { DeviceLink, LinkStream } from '@byokit/pair';
import type {
  AgentRef, AgentStatus, BlockedAgent, HerdrEventName, HerdrEventOf, HerdrMethod, HerdrParams, HerdrResult,
  HerdrSnapshot, HerdrState, HerdrSubscription, PromptReceipt, StartAgent,
} from './types.ts';

export type {
  HerdrEventName, HerdrEventOf, HerdrEvents, HerdrMethod, HerdrMethods, HerdrParams, HerdrResult, HerdrSubscription,
} from './types.ts';

/** One `hd.events` frame (7.2); `raw` carries a line that was not JSON. */
export type HerdrLinkEvent =
  | { type: 'snapshot'; snapshot: HerdrSnapshot }
  | { type: 'blocked'; change: 'added' | 'resolved'; blocked: BlockedAgent }
  | { type: 'raw'; line: string };

/** A terminal over the link (7.2): Herdr's NDJSON frames both ways. */
export type DeviceTerminal = {
  ready: Promise<void>;                        // first frame; rejects when the stream ends before one
  exited: Promise<{ reason: string | null }>;  // stream end; reason = the host's words, null when clean
  onFrame(fn: (line: string) => void): () => void;
  send(line: string): void;
  close(): void;
};

export { openNotice } from './notices.ts';
export { agentWords, stateWords, words, WORDS, type WordKey } from './words.ts';
import { boxPublicKeyB64, openNotice } from './notices.ts';

const decodeLines = (): { push(chunk: Uint8Array): string[]; flush(): string[] } => {
  const text = new TextDecoder();
  let pending = '';
  return {
    push: (chunk: Uint8Array): string[] => {
      pending += text.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      return lines.filter((line) => line.length > 0);
    },
    flush: (): string[] => {
      pending += text.decode();
      const rest = pending;
      pending = '';
      return rest.length > 0 ? [rest] : [];
    },
  };
};

/**
 * A link stream as newline-delimited JSON frames; unparsed lines surface as `{ type: 'raw', line }`. A plain
 * iterator rather than an async generator: `return()` (a `break`, or a view that stops watching) ends the link
 * stream even while a `next()` waits for the next frame, which a generator parked at an await cannot do.
 */
function streamFrames(link: DeviceLink, op: string, args: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      const ready: unknown[] = [];
      const lines = decodeLines();
      let s: LinkStream | undefined;
      let opening: Promise<void> | undefined;
      let failed: { error: unknown } | undefined;
      let ended = false;
      let closed = false;
      let wake: (() => void) | undefined;
      const rouse = (): void => { wake?.(); wake = undefined; };
      const emit = (frame: unknown): void => { ready.push(frame); rouse(); };
      const open = (): Promise<void> => opening ??= link.stream(op, args).then((opened) => {
        if (closed) { opened.end(); return; }
        s = opened;
        opened.onData = (chunk: Uint8Array) => {
          for (const line of lines.push(chunk)) {
            try { emit(JSON.parse(line)); } catch { emit({ type: 'raw', line }); }
          }
        };
        opened.onEnd = () => {
          for (const line of lines.flush()) emit({ type: 'raw', line });
          ended = true;
          rouse();
        };
      }, (error: unknown) => { failed = { error }; rouse(); });
      return {
        async next(): Promise<IteratorResult<unknown>> {
          void open();
          for (;;) {
            if (closed) return { value: undefined, done: true };
            if (ready.length > 0) return { value: ready.shift(), done: false };
            if (failed) throw failed.error;
            if (ended) return { value: undefined, done: true };
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
        async return(): Promise<IteratorResult<unknown>> {
          if (!closed) {
            closed = true;
            s?.end();
            rouse();
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const terminalHandle = (opening: Promise<LinkStream>): DeviceTerminal => {
  const listeners = new Set<(line: string) => void>();
  const lines = decodeLines();
  let s: LinkStream | undefined;
  const queued: string[] = [];
  let dead = false;
  let framed = false;
  let markReady!: () => void;
  let failReady!: (e: Error) => void;
  let markExited!: (v: { reason: string | null }) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
  const exited = new Promise<{ reason: string | null }>((resolve) => { markExited = resolve; });
  ready.catch(() => {}); // an app that never awaits ready must not see an unhandled rejection
  const deliver = (line: string): void => {
    if (!framed) { framed = true; markReady(); }
    for (const fn of listeners) fn(line);
  };
  const finish = (reason: string | null): void => {
    dead = true;
    if (!framed) failReady(new Error(reason ?? 'herdr: the terminal ended before its first frame'));
    markExited({ reason });
  };
  // The handle returns synchronously; the stream opens underneath and sends made before it opens
  // queue until then (frames cannot arrive before the open anyway).
  opening.then((opened) => {
    if (dead) { opened.end(); return; }
    s = opened;
    opened.onData = (chunk: Uint8Array) => {
      for (const line of lines.push(chunk)) deliver(line);
    };
    opened.onEnd = (error?: string) => {
      for (const line of lines.flush()) deliver(line);
      finish(error ?? null);
    };
    for (const line of queued.splice(0)) void opened.write(`${line}\n`).catch(() => {});
  }, (e: unknown) => { finish(e instanceof Error ? e.message : 'failed'); });
  return {
    ready,
    exited,
    onFrame: (fn: (line: string) => void): (() => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    send: (line: string): void => {
      if (s !== undefined && !dead) void s.write(`${line}\n`).catch(() => {});
      else if (!dead) queued.push(line);
    },
    close: (): void => {
      if (dead) return;
      s?.end();
      finish(null);
    },
  };
};

/** `hd.subscribe`: one parsed frame per Herdr event; a host end with words reaches `onError`. */
const subscription = (opening: Promise<LinkStream>, on: (e: unknown) => void,
  onError?: (message: string) => void): () => void => {
  const lines = decodeLines();
  let s: LinkStream | undefined;
  let stopped = false;
  const deliver = (line: string): void => {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { return; }
    if (!stopped) on(frame);
  };
  opening.then((opened) => {
    if (stopped) { opened.end(); return; }
    s = opened;
    opened.onData = (chunk: Uint8Array) => { for (const line of lines.push(chunk)) deliver(line); };
    opened.onEnd = (error?: string) => {
      for (const line of lines.flush()) deliver(line);
      if (!stopped && error !== undefined) onError?.(error);
      stopped = true;
    };
  }, (e: unknown) => {
    if (!stopped) onError?.(e instanceof Error ? e.message : 'failed');
    stopped = true;
  });
  return () => {
    if (stopped) return;
    stopped = true;
    s?.end();
  };
};

export function herdrDevice(link: DeviceLink): {
  state(): Promise<{ state: HerdrState; words: string }>;
  tree(): Promise<HerdrSnapshot>;
  agentKinds(): Promise<string[]>;
  startAgent(o: StartAgent): Promise<AgentRef>;
  prompt(paneId: string, text: string): Promise<PromptReceipt>;
  keys(paneId: string, keys: string[]): Promise<void>;
  wait(paneId: string, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus>;
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number }):
    Promise<{ text: string; truncated: boolean }>;
  blocked(): Promise<BlockedAgent[]>;
  answer(paneId: string, keys: string[], revision: number): Promise<void>;
  close(o: { pane?: string; tab?: string; workspace?: string }): Promise<void>;
  events(): AsyncIterable<HerdrLinkEvent>;
  subscribe<E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void,
    onError?: (message: string) => void): () => void;
  registerNotices(seed: Uint8Array): Promise<void>;         // derives the box key with @byokit/seal
  openNotice(data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null;
  call<M extends HerdrMethod>(method: M, params: HerdrParams<M>): Promise<HerdrResult<M>>;
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): DeviceTerminal;
} {
  if (!link) throw new Error('herdr: herdrDevice needs a link');
  return {
    state: () => link.request('hd.state', {}) as Promise<{ state: HerdrState; words: string }>,
    tree: () => link.request('hd.tree', {}) as Promise<HerdrSnapshot>,
    agentKinds: () => link.request('hd.kinds', {}) as Promise<string[]>,
    startAgent: (o: StartAgent) => link.request('hd.agent.start', o) as Promise<AgentRef>,
    prompt: (paneId: string, text: string) =>
      link.request('hd.prompt', { paneId, text }) as Promise<PromptReceipt>,
    keys: async (paneId: string, keys: string[]): Promise<void> => {
      await link.request('hd.keys', { paneId, keys });
    },
    wait: (paneId: string, o: { until?: AgentStatus[]; timeoutMs: number }) =>
      link.request('hd.wait', { paneId, ...o }) as Promise<AgentStatus>,
    read: (paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number }) =>
      link.request('hd.read', { paneId, ...o }) as Promise<{ text: string; truncated: boolean }>,
    blocked: () => link.request('hd.blocked', {}) as Promise<BlockedAgent[]>,
    answer: async (paneId: string, keys: string[], revision: number): Promise<void> => {
      await link.request('hd.answer', { paneId, keys, revision });
    },
    close: async (o: { pane?: string; tab?: string; workspace?: string }): Promise<void> => {
      await link.request('hd.close', o);
    },
    events: () => streamFrames(link, 'hd.events', {}) as AsyncIterable<HerdrLinkEvent>,
    subscribe: <E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void,
      onError?: (message: string) => void) =>
      subscription(link.stream('hd.subscribe', { subs }), on as (e: unknown) => void, onError),
    registerNotices: async (seed: Uint8Array): Promise<void> => {
      await link.request('hd.notices.register', { boxPublicKey: boxPublicKeyB64(seed) });
    },
    openNotice: (data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null => openNotice(data, seed),
    call: <M extends HerdrMethod>(method: M, params: HerdrParams<M>) =>
      link.request('hd.call', { method, params }) as Promise<HerdrResult<M>>,
    terminal: (paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }) =>
      terminalHandle(link.stream('hd.terminal', { paneId, ...o })),
  };
}
