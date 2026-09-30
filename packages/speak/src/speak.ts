// The JS core over an injected engine: argument checks before any engine call, on every platform, and listener
// sets fed by the engine's callbacks. Pure: no platform import, so every entry can use it.
import type { SpeakErrorCode, SpeakEvent, SpeakEventType, SpeakHandle, SpeakOptions, Speaker, Voice } from './types.ts';
import { SpeakError } from './types.ts';

/** The platform seam browser.ts and native.ts implement; null means unsupported (Node with no injected engine). */
export interface SpeakEngine {
  voices(): Promise<Voice[]>;
  speak(
    id: number, text: string, o: { voice: string | null; rate: number; pitch: number },
    emit: (type: 'start' | 'end' | 'error', message?: string) => void,
  ): void;
  cancel(id: number): void;
  stopAll(): void;
}

function check(text: string, o: SpeakOptions): { voice: string | null; rate: number; pitch: number } {
  if (typeof text !== 'string') throw new TypeError('speak: text must be a string');
  if (!text.trim()) throw new SpeakError('invalid', 'speak: text must not be empty');
  if (o.rate !== undefined && (typeof o.rate !== 'number' || !(o.rate >= 0.25 && o.rate <= 4))) {
    throw new RangeError('speak: rate must be a number from 0.25 to 4');
  }
  if (o.pitch !== undefined && (typeof o.pitch !== 'number' || !(o.pitch >= 0 && o.pitch <= 2))) {
    throw new RangeError('speak: pitch must be a number from 0 to 2');
  }
  if (o.voice !== undefined && typeof o.voice !== 'string') throw new TypeError('speak: voice must be a string');
  return { voice: o.voice ?? null, rate: o.rate ?? 1, pitch: o.pitch ?? 1 };
}

/** The speaker over an engine, or the `unsupported` one when there is none (Node with no injected engine). */
export function createSpeaker(engine: SpeakEngine | null): Speaker {
  if (!engine) {
    const unsupported = (text: string, o: SpeakOptions = {}): SpeakHandle => {
      check(text, o);
      o.signal?.throwIfAborted();
      let cancel!: () => void;
      const done = new Promise<void>((_, reject) => {
        cancel = () => reject(new SpeakError('interrupted', 'speak: cancelled'));
        queueMicrotask(() => reject(new SpeakError('unavailable', 'speak: no text-to-speech engine on this platform')));
      });
      done.catch(() => {});
      const on = <T extends SpeakEventType>(
        type: T, fn: (e: Extract<SpeakEvent, { type: T }>) => void,
      ): (() => void) => {
        if (type === 'error') {
          queueMicrotask(() =>
            fn({ type: 'error', error: new SpeakError('unavailable', 'speak: unavailable') } as never)
          );
        }
        return () => {};
      };
      if (o.signal) {
        const onAbort = (): void => cancel();
        o.signal.addEventListener('abort', onAbort, { once: true });
        const cleanup = (): void => o.signal?.removeEventListener('abort', onAbort);
        void done.then(cleanup, cleanup);
      }
      return { done, cancel, on };
    };
    return { speak: unsupported, voices: async () => [], stop: () => {} };
  }
  let nextId = 1;
  const live = new Map<number, { settled: () => void }>();
  return {
    speak(text, o = {}) {
      const opts = check(text, o);
      o.signal?.throwIfAborted();
      const id = nextId++;
      const sets = new Map<SpeakEventType, Set<(e: SpeakEvent) => void>>();
      const emit = (e: SpeakEvent): void => {
        for (const fn of [...(sets.get(e.type) ?? [])]) {
          try { fn(e); } catch { /* one throwing listener never stops the rest */ }
        }
      };
      let settle!: (fn: () => void) => void;
      const done = new Promise<void>((resolve, reject) => {
        let done = false;
        settle = (fn) => {
          if (done) return;
          done = true;
          live.delete(id);
          fn();
        };
        const emitNative = (type: 'start' | 'end' | 'error', message?: string): void => {
          if (type === 'start') emit({ type: 'start' });
          else if (type === 'end') settle(() => { emit({ type: 'end' }); resolve(); });
          else {
            const error = new SpeakError('failed', `speak: ${message ?? 'the platform could not speak the text'}`);
            settle(() => { emit({ type: 'error', error }); reject(error); });
          }
        };
        try {
          live.set(id, { settled: () => settle(() => reject(o.signal?.reason ?? new SpeakError('interrupted', 'speak: cancelled'))) });
          engine.speak(id, text, opts, emitNative);
        } catch (cause) {
          const error = new SpeakError('failed', 'speak: the engine rejected the utterance', { cause });
          settle(() => { emit({ type: 'error', error }); reject(error); });
        }
      });
      done.catch(() => {});
      const cancel = (): void => {
        if (!live.has(id)) return;
        try { engine.cancel(id); } catch { /* cancelling never throws */ }
        const rec = live.get(id);
        live.delete(id);
        rec?.settled();
        emit({ type: 'error', error: new SpeakError('interrupted', 'speak: cancelled') });
      };
      if (o.signal) {
        const onAbort = (): void => {
          if (!live.has(id)) return;
          try { engine.cancel(id); } catch { /* aborting never throws */ }
          const rec = live.get(id);
          live.delete(id);
          rec?.settled();
        };
        o.signal.addEventListener('abort', onAbort, { once: true });
        const cleanup = (): void => o.signal?.removeEventListener('abort', onAbort);
        void done.then(cleanup, cleanup);
      }
      const on = <T extends SpeakEventType>(
        type: T, fn: (e: Extract<SpeakEvent, { type: T }>) => void,
      ): (() => void) => {
        const set = sets.get(type) ?? new Set();
        sets.set(type, set);
        const entry = (e: SpeakEvent): void => fn(e as never);
        set.add(entry);
        return () => { set.delete(entry); };
      };
      return { done, cancel, on };
    },
    voices: () => engine.voices(),
    stop: () => {
      try { engine.stopAll(); } catch { /* stopping never throws */ }
      for (const [id, rec] of [...live]) {
        live.delete(id);
        rec.settled();
      }
    },
  };
}

export type { SpeakErrorCode, SpeakEvent, SpeakEventType, SpeakHandle, SpeakOptions, Speaker, Voice } from './types.ts';
export { SpeakError } from './types.ts';
