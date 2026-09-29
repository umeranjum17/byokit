// The phone and browser side (portable: no Node import anywhere in it): typed calls to a host running this kit's
// link adapter (docs/runtime-kits.md 7.2) — behavior lands in H7.
import type { DeviceLink, LinkStream } from '@byokit/link';
import type {
  AgentRef, BlockedAgent, HerdrSnapshot, HerdrState, PromptReceipt, StartAgent,
} from './types.ts';

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

/** A link stream as newline-delimited JSON frames; unparsed lines surface as `{ type: 'raw', line }`. */
async function* streamFrames(link: DeviceLink, op: string, args: unknown): AsyncIterable<unknown> {
  const s = await link.stream(op, args);
  const ready: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const lines = decodeLines();
  const emit = (frame: unknown): void => {
    ready.push(frame);
    wake?.();
    wake = undefined;
  };
  s.onData = (chunk: Uint8Array) => {
    for (const line of lines.push(chunk)) {
      try {
        emit(JSON.parse(line));
      } catch {
        emit({ type: 'raw', line });
      }
    }
  };
  s.onEnd = () => {
    for (const line of lines.flush()) emit({ type: 'raw', line });
    ended = true;
    wake?.();
    wake = undefined;
  };
  for (;;) {
    while (ready.length > 0) yield ready.shift();
    if (ended) return;
    await new Promise<void>((resolve) => { wake = resolve; });
  }
}

const terminalHandle = (opening: Promise<LinkStream>): {
  onFrame(fn: (line: string) => void): () => void; send(line: string): void; close(): void;
} => {
  const listeners = new Set<(line: string) => void>();
  const lines = decodeLines();
  let s: LinkStream | undefined;
  const queued: string[] = [];
  let dead = false;
  // The frozen H7 signature returns the handle synchronously; the stream opens underneath and
  // sends made before it opens queue until then (frames cannot arrive before the open anyway).
  opening.then((opened) => {
    if (dead) { opened.end(); return; }
    s = opened;
    opened.onData = (chunk: Uint8Array) => {
      for (const line of lines.push(chunk)) {
        for (const fn of listeners) fn(line);
      }
    };
    opened.onEnd = () => {
      for (const line of lines.flush()) {
        for (const fn of listeners) fn(line);
      }
    };
    for (const line of queued.splice(0)) void opened.write(`${line}\n`).catch(() => {});
  }, () => { dead = true; });
  return {
    onFrame: (fn: (line: string) => void): (() => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    send: (line: string): void => {
      if (s !== undefined) void s.write(`${line}\n`).catch(() => {});
      else if (!dead) queued.push(line);
    },
    close: (): void => { dead = true; s?.end(); },
  };
};

export function herdrDevice(link: DeviceLink): {
  state(): Promise<{ state: HerdrState; words: string }>;
  tree(): Promise<HerdrSnapshot>;
  startAgent(o: StartAgent): Promise<AgentRef>;
  prompt(paneId: string, text: string): Promise<PromptReceipt>;
  keys(paneId: string, keys: string[]): Promise<void>;
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number }):
    Promise<{ text: string; truncated: boolean }>;
  blocked(): Promise<BlockedAgent[]>;
  answer(paneId: string, keys: string[], revision: number): Promise<void>;
  close(o: { pane?: string; tab?: string; workspace?: string }): Promise<void>;
  events(): AsyncIterable<unknown>;
  registerNotices(seed: Uint8Array): Promise<void>;         // derives the box key with @byokit/seal
  openNotice(data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null;
  call(method: string, params?: unknown): Promise<unknown>;
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): {
    onFrame(fn: (line: string) => void): () => void; send(line: string): void; close(): void;
  };
} {
  if (!link) throw new Error('herdr: herdrDevice needs a link');
  return {
    state: () => link.request('hd.state', {}) as Promise<{ state: HerdrState; words: string }>,
    tree: () => link.request('hd.tree', {}) as Promise<HerdrSnapshot>,
    startAgent: (o: StartAgent) => link.request('hd.agent.start', o) as Promise<AgentRef>,
    prompt: (paneId: string, text: string) =>
      link.request('hd.prompt', { paneId, text }) as Promise<PromptReceipt>,
    keys: async (paneId: string, keys: string[]): Promise<void> => {
      await link.request('hd.keys', { paneId, keys });
    },
    read: (paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number }) =>
      link.request('hd.read', { paneId, ...o }) as Promise<{ text: string; truncated: boolean }>,
    blocked: () => link.request('hd.blocked', {}) as Promise<BlockedAgent[]>,
    answer: async (paneId: string, keys: string[], revision: number): Promise<void> => {
      await link.request('hd.answer', { paneId, keys, revision });
    },
    close: async (o: { pane?: string; tab?: string; workspace?: string }): Promise<void> => {
      await link.request('hd.close', o);
    },
    events: () => streamFrames(link, 'hd.events', {}),
    registerNotices: async (seed: Uint8Array): Promise<void> => {
      await link.request('hd.notices.register', { boxPublicKey: boxPublicKeyB64(seed) });
    },
    openNotice: (data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null => openNotice(data, seed),
    call: (method: string, params?: unknown) =>
      link.request('hd.call', { method, params }) as Promise<unknown>,
    terminal: (paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }) =>
      terminalHandle(link.stream('hd.terminal', { paneId, ...o })),
  };
}
