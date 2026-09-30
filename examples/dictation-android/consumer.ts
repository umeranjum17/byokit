import { Dictation, DictateError, systemEngine, type DictateSystemNative, type DictateSegment } from '@byokit/dictation';

// This example owns the native bridge; the published kit stays portable.
declare const Android: {
  available(locale: string): string;
  start(id: string, options: string): void;
  stop(id: string): void;
  cancel(id: string): void;
  report(result: string): void;
};
type NativeEvent = { type: 'segment'; segment: DictateSegment } | { type: 'stopped' | 'cancelled' } | { type: 'error'; code: string };
declare global { interface Window { dictationNativeEvent(id: string, event: NativeEvent): void } }
const sessions = new Map<string, { on: (s: DictateSegment) => void; resolve?: () => void; reject?: (e: Error) => void; error?: Error }>();
let nextId = 0;
window.dictationNativeEvent = (id, event) => {
  const session = sessions.get(id);
  if (!session) return;
  if (event.type === 'segment') session.on(event.segment);
  else if (event.type === 'error') {
    session.error = new Error(event.code); session.reject?.(session.error);
  } else {
    session.resolve?.(); sessions.delete(id);
  }
};
const native: DictateSystemNative = {
  async available(locale) { return Android.available(locale) as Awaited<ReturnType<DictateSystemNative['available']>>; },
  start(options, on) {
    const id = String(++nextId), session = { on } as { on: typeof on; resolve?: () => void; reject?: (e: Error) => void; error?: Error };
    sessions.set(id, session); Android.start(id, JSON.stringify(options));
    return {
      stop: () => new Promise<void>((resolve, reject) => {
        if (!sessions.has(id)) { resolve(); return; }
        session.resolve = resolve; session.reject = reject;
        if (session.error) { sessions.delete(id); reject(session.error); return; }
        Android.stop(id);
      }),
      cancel() { Android.cancel(id); sessions.delete(id); },
    };
  },
};
async function run() {
  const dictation = new Dictation({ engine: systemEngine(native) });
  const missing = await dictation.available({ locale: 'xx', onDeviceOnly: true });
  if (missing.ok || missing.code !== 'needs-download') throw new Error('missing language pack was not reported');
  const handle = dictation.listen({ languages: ['en-US'], onDeviceOnly: true, punctuation: false, replacements: { kit: 'app' } });
  const partials: string[] = [];
  const settled = new Promise<void>(resolve => handle.on('partial', ({ segment }) => {
    partials.push(segment.text); if (segment.text === 'hello kit') resolve();
  }));
  await settled;
  const finishing = handle.finish();
  if (handle.finish() !== finishing) throw new Error('finish must be idempotent');
  const result = await finishing;
  const cancelled = dictation.listen({ languages: ['en-US'], onDeviceOnly: true });
  await new Promise<void>(resolve => cancelled.on('partial', () => resolve()));
  cancelled.cancel();
  let cancelCode = '';
  try { await cancelled.finish(); } catch (e) { if (e instanceof DictateError) cancelCode = e.code; else throw e; }
  return { text: result.text, partials, engine: result.engine, usage: result.usage, language: result.language,
    final: result.segments.every(s => s.final), idle: dictation.state.phase === 'idle', cancelCode, missing: missing.code };
}
void run().then(result => {
  const text = JSON.stringify(result); document.getElementById('result')!.textContent = text; Android.report(text);
}, e => Android.report(JSON.stringify({ error: String(e) })));
