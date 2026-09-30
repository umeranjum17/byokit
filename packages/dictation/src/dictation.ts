import { DictateError, type DictateEngine, type DictateOptions, type DictateInput, type DictateTranscript, type DictateSegment, type DictationState, type DictationEvent, type DictationHandle, type AudioMic, type AudioMicStream } from './types.ts';
import { applyWordReplacements, settleWords, wav, rms } from './text.ts';

export class Dictation {
  readonly engine: DictateEngine;
  private audio?: AudioMic;
  private notify?: (s: DictationState) => void;
  private current: DictationState = { phase: 'idle' };
  constructor(o: { engine: DictateEngine; audio?: AudioMic; onState?: (s: DictationState) => void }) {
    this.engine = o.engine; this.audio = o.audio; this.notify = o.onState;
  }
  get state(): DictationState { return { ...this.current }; }
  private stateTo(phase: DictationState['phase']) { this.current = { phase }; this.notify?.(this.state); }
  private local(o: DictateOptions) { if (o.onDeviceOnly && !this.engine.info.onDevice) throw new DictateError('not-local'); }
  async available(o: { onDeviceOnly?: boolean; locale?: string } = {}) {
    if (o.onDeviceOnly && !this.engine.info.onDevice) return { ok: false as const, code: 'not-local' as const };
    const code = await this.engine.available?.(o.locale) ?? 'ready';
    return code === 'ready' ? { ok: true as const } : { ok: false as const, code };
  }
  async transcribe(input: DictateInput, o: DictateOptions = {}): Promise<DictateTranscript> {
    this.local(o); o.signal?.throwIfAborted();
    const result = await this.engine.transcribe(input, o);
    return this.finalize({ ...result, engine: this.engine.info }, o);
  }
  private finalize(t: DictateTranscript, o: DictateOptions): DictateTranscript {
    const segments = t.segments.map(s => ({ ...s, final: true, text: applyWordReplacements(s.text, o.replacements) }));
    return { ...t, text: segments.length ? segments.map(s => s.text).join(' ').trim() : applyWordReplacements(t.text, o.replacements), segments };
  }
  listen(o: DictateOptions = {}): DictationHandle {
    this.local(o);
    if (this.state.phase !== 'idle') throw new DictateError('mic-busy');
    o.signal?.throwIfAborted();
    if (!this.engine.start && !this.audio) throw new DictateError('unsupported');
    this.stateTo('listening');
    const controller = new AbortController();
    const options = { ...o, signal: controller.signal };
    const listeners = new Map<string, Set<(e: DictationEvent) => void>>();
    const emit = (e: DictationEvent) => { if (!cancelled) for (const fn of listeners.get(e.type) ?? []) fn(e); };
    const segments = new Map<string, DictateSegment>();
    const prior = new Map<string, string>();
    let cancelled = false, stopped = false, stream: AudioMicStream | undefined;
    let native: ReturnType<NonNullable<DictateEngine['start']>> | undefined;
    let failure: unknown, finished: Promise<DictateTranscript> | undefined;
    let chunks: Int16Array[] = [], samples = 0, readAt = 0, speechAt = 0, silence = 0, offset = 0, id = 0;
    let latest: Omit<DictateTranscript, 'engine'> | undefined;
    let usage: DictateTranscript['usage'] = { audioMs: 0, basis: this.engine.info.account === 'plan' ? 'subscription' : this.engine.info.account === 'key' ? 'minutes' : 'free' };
    const receive = (s: DictateSegment) => {
      const old = segments.get(s.id);
      if (old?.final) return;
      const text = s.final ? applyWordReplacements(s.text, o.replacements) : settleWords(old?.text ?? '', prior.get(s.id) ?? '', s.text);
      prior.set(s.id, s.text);
      const segment = { ...s, text };
      segments.set(s.id, segment);
      emit(s.final ? { type: 'final', segment } : { type: 'partial', segment });
    };
    const read = async (final: boolean) => {
      if (cancelled || !speechAt) return;
      if (speechAt > readAt) {
        latest = await this.engine.transcribe(wav(chunks), options);
        readAt = samples;
        if (cancelled) return;
        usage = { ...usage, costUsd: latest.usage.costUsd === undefined ? usage.costUsd : (usage.costUsd ?? 0) + latest.usage.costUsd, inputTokens: latest.usage.inputTokens === undefined ? usage.inputTokens : (usage.inputTokens ?? 0) + latest.usage.inputTokens };
      }
      if (!latest) return;
      receive({ id: String(id), text: latest.text, final, startMs: offset, endMs: offset + samples / 16, language: latest.language,
        words: latest.segments.flatMap(s => s.words ?? []).map(w => ({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset })) });
      if (final) {
        emit({ type: 'turn', phase: 'end' });
        offset += samples / 16; chunks = []; samples = readAt = speechAt = silence = 0; latest = undefined; id++;
      }
    };
    const ready = (async () => {
      const availability = await this.available({ onDeviceOnly: o.onDeviceOnly, locale: o.languages?.[0] });
      if (!availability.ok) throw new DictateError(availability.code);
      if (cancelled || stopped) return;
      if (this.engine.start) { native = this.engine.start(options, receive); return; }
      stream = await this.audio!.open({ rate: 16000, purpose: 'dictation', signal: controller.signal });
      if (cancelled || stopped) { await stream.stop(); return; }
    })();
    const capture = ready.then(async () => {
      if (!stream || stopped || cancelled) return;
      for await (const frame of stream) {
        if (stopped || cancelled) break;
        const level = rms(frame.data);
        emit({ type: 'level', rms: level });
        chunks.push(frame.data.slice()); samples += frame.data.length; usage.audioMs += frame.data.length / 16;
        if (level >= 0.06) {
          if (!speechAt) emit({ type: 'turn', phase: 'start' });
          speechAt = samples; silence = 0;
        } else silence += frame.data.length;
        // Cap the live window independently of provider file-size limits.
        if (samples > 60 * 16000) throw new DictateError('too-large');
        if (speechAt && silence >= 8000) await read(true);
        else if (this.engine.info.streaming === 'reread' && speechAt > readAt && samples - readAt >= 16000) await read(false);
        else if (!speechAt && silence >= 8000) { offset += samples / 16; chunks = []; samples = silence = 0; }
      }
    }).catch(async e => { failure = e; stopped = true; await stream?.stop(); });
    const cleanup = async () => { await stream?.stop(); o.signal?.removeEventListener('abort', abort); this.stateTo('idle'); };
    const cancel = () => {
      if (cancelled || this.state.phase === 'idle') return;
      cancelled = stopped = true; controller.abort(); native?.cancel();
      void Promise.all([ready.catch(() => {}), capture]).then(cleanup).catch(() => { this.stateTo('idle'); });
    };
    const abort = () => cancel();
    o.signal?.addEventListener('abort', abort, { once: true });
    return {
      on(type, fn) {
        const set = listeners.get(type) ?? new Set(); listeners.set(type, set);
        const wrapped = fn as (e: DictationEvent) => void; set.add(wrapped);
        return () => { set.delete(wrapped); };
      },
      finish: () => {
        if (finished) return finished;
        finished = (async () => {
          stopped = true;
          if (!cancelled) this.stateTo('settling');
          try {
            await ready; await stream?.stop(); await capture;
            if (cancelled) throw new DictateError('cancelled');
            if (failure) throw failure;
            await native?.stop();
            if (!native) await read(true);
            if (cancelled) throw new DictateError('cancelled');
            const final = [...segments.values()].map(s => ({ ...s, text: s.final ? s.text : applyWordReplacements(s.text, o.replacements), final: true }));
            if (native) usage.audioMs = Math.max(0, ...final.map(s => s.endMs ?? 0));
            return { text: final.map(s => s.text).join(' ').trim(), segments: final, usage, engine: this.engine.info, durationMs: usage.audioMs, language: final.find(s => s.language)?.language };
          } finally { await cleanup(); }
        })();
        return finished;
      },
      cancel,
    };
  }
}
