// Keeping a live view going over a link: a view's event stream ends whenever the link drops or the host restarts, so
// it opens again after a pause until the view stops or the pairing is gone for good. Framework-free.

export type Stop = () => void;

/** A view any UI can draw from: the current state, and a way to hear each change (the returned function stops). */
export type Store<T> = { get(): T; subscribe(fn: (state: T) => void): () => void };

type Live = { hold(it: AsyncIterator<unknown>): void; stopped(): boolean };

// Removed (unpaired) and stopped (the app stopped the link) never come back by themselves.
const final = (e: unknown) => {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return code === 'removed' || code === 'stopped';
};

// ponytail: fixed pause between tries, no backoff; the link paces its own reconnects, so a stream only reopens
// into a link that is either back (it works) or still away (it fails at once, cheaply).
export function retrying(attempt: (live: Live) => Promise<void>, retryMs: number): Stop {
  let stopped = false;
  let current: AsyncIterator<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const live: Live = {
    hold: (it) => { current = it; if (stopped) void it.return?.(); },
    stopped: () => stopped,
  };
  void (async () => {
    while (!stopped) {
      try {
        await attempt(live);
      } catch (e) {
        if (final(e)) return;
      }
      current = undefined;
      if (stopped) return;
      await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, retryMs); });
    }
  })();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    wake?.();
    void current?.return?.();
  };
}

/** A store that follows its source only while someone listens: the first listener starts it, the last one stops it. */
export function store<T>(initial: T, follow: (set: (state: T) => void) => Stop): Store<T> & { set(state: T): void } {
  let state = initial;
  let stop: Stop | undefined;
  const listeners = new Set<(state: T) => void>();
  const set = (next: T) => {
    if (next === state) return;
    state = next;
    for (const fn of [...listeners]) fn(state);
  };
  return {
    get: () => state,
    set,
    subscribe: (fn) => {
      listeners.add(fn);
      stop ??= follow(set);
      return () => {
        if (!listeners.delete(fn) || listeners.size > 0) return;
        const s = stop;
        stop = undefined;
        s?.();
      };
    },
  };
}
