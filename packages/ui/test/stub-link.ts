// A scripted link for the kits' real device clients: requests answer from a function, and each stream the device
// opens is handed to the test to feed lines into, end, and check whether the device ended it.
import type { DeviceLink, LinkStream } from '@byokit/link';

export type Opened = { op: string; args: unknown; line(frame: unknown): void; end(error?: string): void; ended: boolean };

export function stubLink(answer: (op: string, args: unknown) => unknown) {
  const opened: Opened[] = [];
  const waiting: ((o: Opened) => void)[] = [];
  const unclaimed: Opened[] = [];
  let refuse: unknown;
  const tries = { count: 0 };
  const link = {
    request: async (op: string, args?: unknown) => answer(op, args),
    stream: async (op: string, args?: unknown): Promise<LinkStream> => {
      tries.count++;
      if (refuse) throw refuse;
      const s = { onData: undefined, onEnd: undefined, write: async () => {}, end: () => { o.ended = true; } } as unknown as LinkStream;
      const o: Opened = {
        op, args, ended: false,
        line: (frame) => s.onData?.(new TextEncoder().encode(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`)),
        end: (error) => s.onEnd?.(error),
      };
      opened.push(o);
      // The device sets its handlers right after the open resolves; hand the stream over after that.
      setTimeout(() => { const take = waiting.shift(); if (take) take(o); else unclaimed.push(o); }, 0);
      return s;
    },
  } as unknown as DeviceLink;
  return {
    link, opened, tries,
    /** The next stream the device opens, once it is listening. */
    next: () => new Promise<Opened>((resolve) => { const o = unclaimed.shift(); if (o) resolve(o); else waiting.push(resolve); }),
    /** Every stream opened from now on fails with `e` (undefined: they open again). */
    refuse: (e: unknown) => { refuse = e; },
  };
}

/** Resolves once `check` holds, polling each tick; fails after `ms`. */
export async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
