// One agent run as a person sees it: the reply streaming in, the tools it uses, and how it ended in plain words.
// Framework-free; typed structurally against `@byokit/openclaw/device`'s `run()`, so nothing here imports a kit.
//   idle      nothing sent yet          running   the reply is streaming in
//   done      the reply is complete     stopped   stopped before the end (here, or aborted on the computer)
//   failed    it ended with a problem: `words` says which, in the kit's own sentence
import { store, type Store } from './follow.ts';

export type RunEvent = { type: 'text'; text: string } | { type: 'tool'; name: string; phase: 'start' | 'end' };
export type RunEnd =
  | { ok: true; text: string }
  | { ok: false; aborted: true }
  | { ok: false; kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other'; until?: number; message: string };
/** One frame of the run stream: an event, then one `end`. */
export type RunFrame = RunEvent | { type: 'end'; end: RunEnd };

export type RunPhase = 'idle' | 'running' | 'done' | 'stopped' | 'failed';
export type RunState = {
  phase: RunPhase;
  /** The reply so far (cumulative), the final reply once done. */
  text: string;
  /** Every tool the run used, in the order it started them; `done` once it finished. */
  tools: { name: string; done: boolean }[];
  end?: RunEnd;
  /** The host's own words when the stream ended without an end (e.g. this device may not run). */
  error?: string;
};
export type RunAction = RunFrame | { type: 'start' } | { type: 'stop' } | { type: 'error'; message: string };

export const RUN_IDLE: RunState = { phase: 'idle', text: '', tools: [] };

export function runStep(s: RunState, a: RunAction): RunState {
  if (a.type === 'start') return { phase: 'running', text: '', tools: [] };
  if (s.phase !== 'running') return s; // a finished run hears nothing more
  switch (a.type) {
    case 'text': return { ...s, text: a.text };
    case 'tool': {
      if (a.phase === 'start') return { ...s, tools: [...s.tools, { name: a.name, done: false }] };
      const at = s.tools.findIndex((t) => t.name === a.name && !t.done);
      return at < 0 ? s : { ...s, tools: s.tools.map((t, i) => (i === at ? { ...t, done: true } : t)) };
    }
    case 'end': {
      const tools = s.tools.map((t) => (t.done ? t : { ...t, done: true }));
      if (a.end.ok) return { phase: 'done', text: a.end.text || s.text, tools, end: a.end };
      return { ...s, phase: 'aborted' in a.end ? 'stopped' : 'failed', tools, end: a.end };
    }
    case 'error': return { ...s, phase: 'failed', error: a.message };
    case 'stop': return { ...s, phase: 'stopped' };
  }
}

/** The kit's sentences a failed run needs (`@byokit/openclaw/device`'s `words` fits). */
export type RunWords = (key: 'member.signedOut' | 'member.resting' | 'member.plan' | 'member.network',
  vars: { name: string; time: string }) => string;
export type RunWordsOptions = {
  words: RunWords;
  /** Who answers, as the person knows it: "ChatGPT". */
  name: string;
  /** How to say the time a resting plan is back; defaults to the device's short local time. */
  time?: (ms: number) => string;
};

const KEY = { 'signed-out': 'member.signedOut', resting: 'member.resting', plan: 'member.plan', network: 'member.network' } as const;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** What to draw: the reply, the tool at work (if any), and the sentence for how it ended ('' when there is none). */
export function runView(s: RunState, { words, name, time = clock }: RunWordsOptions) {
  const end = s.end && !s.end.ok && 'kind' in s.end ? s.end : undefined;
  const said = end && end.kind !== 'other'
    ? words(KEY[end.kind], { name, time: end.until === undefined ? 'later' : time(end.until) })
    : s.error ?? '';
  return {
    phase: s.phase, text: s.text, tools: s.tools,
    /** The tool running right now, the latest one started. */
    tool: s.tools.filter((t) => !t.done).pop()?.name,
    words: said,
  };
}

/** What `runStore` needs from a device client: `openclawDevice(link)` fits. */
export type RunSource = { run(message: string, o?: { sessionKey?: string }): AsyncIterable<RunFrame> };

/**
 * One run at a time from a device: `send` starts one (stopping any still streaming), `stop` stops listening to it.
 * Stopping here does not abort the run on the computer; pair it with the device's `abort(sessionKey)` for that.
 */
export function runStore(source: RunSource): Store<RunState> & {
  send(message: string, o?: { sessionKey?: string }): void;
  stop(): void;
} {
  const s = store<RunState>(RUN_IDLE, () => () => {});
  let current: (() => void) | undefined;
  const send = (message: string, o?: { sessionKey?: string }) => {
    current?.();
    let stopped = false;
    let it: AsyncIterator<RunFrame> | undefined;
    const step = (a: RunAction) => { if (!stopped) s.set(runStep(s.get(), a)); };
    current = () => {
      if (stopped) return;
      step({ type: 'stop' });
      stopped = true;
      void it?.return?.();
    };
    step({ type: 'start' });
    void (async () => {
      try {
        it = source.run(message, o)[Symbol.asyncIterator]();
        for (let r = await it.next(); !r.done && !stopped; r = await it.next()) step(r.value);
        step({ type: 'stop' }); // the stream ended without an end frame
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // A stream the link cut ends with the link's bare reason ('unreachable'), not words: the run stopped here,
        // and the link's own status says why.
        step(/^[a-z][a-z-]*$/.test(message) ? { type: 'stop' } : { type: 'error', message });
      }
    })();
  };
  return { get: s.get, subscribe: s.subscribe, send, stop: () => current?.() };
}
