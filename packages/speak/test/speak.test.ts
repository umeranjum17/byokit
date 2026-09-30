import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeaker, SpeakError } from '../src/index.ts';
import type { SpeakEngine } from '../src/speak.ts';
import { browserEngine } from '../src/index.ts';
import { nativeEngine } from '../src/index.ts';

function fakeEngine(): { engine: SpeakEngine; spoken: { id: number; text: string }[]; emits: Map<number, (t: 'start' | 'end' | 'error', m?: string) => void> } {
  const spoken: { id: number; text: string }[] = [];
  const emits = new Map<number, (t: 'start' | 'end' | 'error', m?: string) => void>();
  const cancelled: number[] = [];
  const engine: SpeakEngine = {
    voices: async () => [{ id: 'v1', name: 'Voice One', lang: 'en-US' }],
    speak: (id, text, _o, emit) => { spoken.push({ id, text }); emits.set(id, emit); },
    cancel: (id) => { cancelled.push(id); },
    stopAll: () => {},
  };
  return { engine, spoken, emits };
}

test('speak resolves on end and reports start/end events with full pass-through', async () => {
  const { engine, spoken, emits } = fakeEngine();
  const seen: string[] = [];
  const h = createSpeaker(engine).speak('Hi Umer', { voice: 'v1', rate: 1.2, pitch: 0.9 });
  h.on('start', () => seen.push('start'));
  h.on('end', () => seen.push('end'));
  assert.equal(spoken.length, 1);
  emits.get(spoken[0].id)?.('start');
  emits.get(spoken[0].id)?.('end');
  await h.done;
  assert.deepEqual(seen, ['start', 'end']);
});

test('engine errors reject done with SpeakError failed and emit error', async () => {
  const { engine, spoken, emits } = fakeEngine();
  const s = createSpeaker(engine);
  const h = s.speak('Hi Umer');
  let code = '';
  h.on('error', (e) => { code = e.error.code; });
  emits.get(spoken[0].id)?.('error', 'no audio');
  await assert.rejects(h.done, (e: unknown) => e instanceof SpeakError && e.code === 'failed');
  assert.equal(code, 'failed');
});

test('cancel rejects done as interrupted', async () => {
  const s = createSpeaker({ ...fakeEngine().engine });
  const h = s.speak('Hi Umer');
  h.cancel();
  await assert.rejects(h.done, (e: unknown) => e instanceof SpeakError && e.code === 'interrupted');
});

test('abort rejects done with the signal reason', async () => {
  const s = createSpeaker(fakeEngine().engine);
  const c = new AbortController();
  const h = s.speak('Hi Umer', { signal: c.signal });
  const reason = new Error('gone');
  c.abort(reason);
  await assert.rejects(h.done, (e: unknown) => e === reason);
});

test('empty text is invalid, bad types throw, bad ranges throw RangeError', async () => {
  const s = createSpeaker(fakeEngine().engine);
  assert.throws(() => s.speak('  '), (e: unknown) => e instanceof SpeakError && (e as SpeakError).code === 'invalid');
  assert.throws(() => s.speak(7 as unknown as string), TypeError);
  assert.throws(() => s.speak('hi', { rate: 9 }), RangeError);
  assert.throws(() => s.speak('hi', { pitch: -1 }), RangeError);
  const c = new AbortController();
  c.abort();
  assert.throws(() => s.speak('hi', { signal: c.signal }), /abort/i);
});

test('no engine is unsupported: voices empty, speak rejects unavailable', async () => {
  const s = createSpeaker(null);
  assert.deepEqual(await s.voices(), []);
  const h = s.speak('Hi Umer');
  let code = '';
  h.on('error', (e) => { code = e.error.code; });
  await assert.rejects(h.done, (e: unknown) => e instanceof SpeakError && e.code === 'unavailable');
  assert.equal(code, 'unavailable');
});

test('browser engine passes voice, rate and pitch to the utterance', async () => {
  const utterances: { text: string; voice: unknown; rate: number; pitch: number; onstart: (() => void) | null; onend: (() => void) | null; onerror: ((m: string) => void) | null }[] = [];
  const synth = {
    speak: (u: (typeof utterances)[number]) => { utterances.push(u); u.onstart?.(); u.onend?.(); },
    cancel: () => {},
    getVoices: () => [{ voiceURI: 'v1', name: 'Voice One', lang: 'en-US' }],
  };
  const engine = browserEngine(synth, () => ({ text: '', voice: null, rate: 1, pitch: 1, onstart: null, onend: null, onerror: null }));
  const s = createSpeaker(engine);
  assert.deepEqual(await s.voices(), [{ id: 'v1', name: 'Voice One', lang: 'en-US' }]);
  await s.speak('Hi Umer', { voice: 'v1', rate: 1.5, pitch: 0.5 }).done;
  assert.equal(utterances[0].text, 'Hi Umer');
  assert.deepEqual(utterances[0].voice, { voiceURI: 'v1', name: 'Voice One', lang: 'en-US' });
  assert.equal(utterances[0].rate, 1.5);
  assert.equal(utterances[0].pitch, 0.5);
});

test('native adapter routes events by id and reports voices', async () => {
  let listener!: (e: { id: number; type: 'start' | 'end' | 'error'; message?: string }) => void;
  const calls: unknown[] = [];
  const native = {
    speak: (id: number, text: string, voice: string | null, rate: number, pitch: number) => { calls.push([id, text, voice, rate, pitch]); },
    cancel: (_id: number) => {},
    stopAll: () => {},
    voices: async () => [{ id: 'v', name: 'V', lang: 'en' }],
    addListener: (_e: 'speak', fn: typeof listener) => { listener = fn; return { remove: () => {} }; },
  };
  const s = createSpeaker(nativeEngine(native));
  const h = s.speak('Hi Umer', { rate: 1, pitch: 1 });
  assert.deepEqual(calls[0], [1, 'Hi Umer', null, 1, 1]);
  listener({ id: 999, type: 'end' });
  let ended = false;
  h.on('end', () => { ended = true; });
  listener({ id: 1, type: 'start' });
  listener({ id: 1, type: 'end' });
  await h.done;
  assert.equal(ended, true);
});
