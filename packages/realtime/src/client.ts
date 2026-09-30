import { parseRealtimeClientFrame, parseRealtimeHostFrame, realtimePcm16ByteLength } from './frames.ts';
import type { RealtimeHostFrame } from './frames.ts';
import type { RealtimeClientOptions, RealtimeStream } from './types.ts';
import type { WebRtcHandle } from './webrtc.ts';
/** Provider-blind client with bounded reconnects and exclusive media ownership. */
export function realtimeClient(options: RealtimeClientOptions) {
  const audio = options.audio;
  let stopped = false, muted = false, epoch = 0, reconnects = 0;
  let retry: ReturnType<typeof setTimeout> | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined, stableTimer: ReturnType<typeof setTimeout> | undefined;
  type Attempt = { stream?: RealtimeStream; capture?: Awaited<ReturnType<typeof audio.capture>>; peer?: WebRtcHandle; acquired: boolean; ready: boolean; signal: AbortController; media?: Promise<void> };
  let attempt: Attempt | undefined;
  const mic: { data: string; bytes: number }[] = [], speech: string[] = [];
  let micBytes = 0;
  const stats = { micCaptured: 0, micSent: 0, micQueued: 0, micDropped: 0, transportReconnects: 0, providerReconnects: 0 };
  const cleanup = async (current?: Attempt) => {
    if (!current) return;
    current.signal.abort(); current.stream?.close(); if (current.stream) audio.player.unbind(current.stream);
    await current.media?.catch(() => {});
    current.peer?.stop();
    try { await current.capture?.release(); }
    finally { if (current.acquired) { current.acquired = false; audio.microphone.release(); await audio.unroute(); } }
  };
  const reset = () => { clearTimeout(retry); retry = undefined; clearTimeout(stableTimer); audio.player.clear(); mic.length = 0; micBytes = 0; };
  const stop = (reason?: string) => {
    if (stopped) return;
    stopped = true; epoch++; clearTimeout(reconnectTimer); reset();
    const current = attempt; attempt = undefined;
    current?.stream?.send({ type: 'realtime.control', action: 'stop' });
    void cleanup(current).catch(() => {}); audio.player.stop(); audio.player.release(); speech.length = 0;
    options.onStats?.({ ...stats }); options.onStatus('disconnected', reason);
  };
  const fail = (error: unknown) => stop(error instanceof Error ? error.message : String(error));
  const connected = () => { clearTimeout(stableTimer); stableTimer = setTimeout(() => { reconnects = 0; }, 30000); };
  const schedule = () => { if (!retry && !stopped) retry = setTimeout(() => { retry = undefined; flush(); }, 20); };
  const flush = () => {
    const current = attempt;
    if (!current?.stream || stopped || !current.ready) return;
    while (mic.length) { const next = mic[0]; if (!current.stream.send({ type: 'realtime.audio', data: next.data })) { schedule(); return; } mic.shift(); micBytes -= next.bytes; stats.micSent++; }
    if (speech.length && audio.player.afterDrain('speech', flush)) return;
    while (speech.length) { if (!current.stream.send({ type: 'realtime.say', text: speech[0] })) { schedule(); return; } speech.shift(); }
  };
  const reconnect = (current: Attempt, reason?: string) => {
    if (stopped || attempt !== current) return;
    if (options.retryableClose?.(reason) === false || reconnects >= 2) { stop(reason); return; }
    attempt = undefined; epoch++; reset(); reconnects++; stats.transportReconnects++;
    options.onStatus('connecting', reason);
    // A slow microphone release cannot overlap the next acquisition.
    void cleanup(current).then(() => {
      if (!stopped) reconnectTimer = setTimeout(connect, reconnects * 500);
    }).catch(fail);
  };
  const connect = () => {
    if (stopped) return;
    reconnectTimer = undefined;
    const current: Attempt = { acquired: false, ready: false, signal: new AbortController() };
    attempt = current; const generation = ++epoch;
    const active = () => !stopped && attempt === current && epoch === generation;
    const onAudio = (data: string) => {
      if (!active() || muted) return;
      try {
        const bytes = realtimePcm16ByteLength(data); stats.micCaptured++; options.onActivity?.(); options.onLevel?.('input', data);
        if (micBytes + bytes > 96000) { stats.micDropped++; throw new Error('Microphone buffer overflowed.'); }
        mic.push({ data, bytes }); micBytes += bytes; if (!current.ready) stats.micQueued++; flush();
      } catch (error) { fail(error); }
    };
    const handle = async (raw: RealtimeHostFrame) => {
      if (!active()) return;
      const frame = parseRealtimeHostFrame(raw); options.onActivity?.();
      switch (frame.type) {
        case 'realtime.ready':
          if (current.media) { current.ready = true; stats.providerReconnects++; connected(); flush(); break; }
          current.media = (async () => {
            await audio.microphone.acquire(); current.acquired = true;
            if (!active()) return;
            await audio.route(); if (!active()) return;
            audio.player.ensure(frame.outputRate);
            current.capture = await audio.capture(frame.inputRate, onAudio);
            if (!active()) return;
            current.ready = true; for (const data of current.capture.pending) onAudio(data); connected(); options.onStatus('connected'); flush();
          })();
          await current.media; break;
        case 'realtime.webrtc.start':
          if (current.media) break;
          if (!options.webrtc) throw new Error('Voice media is unsupported.');
          current.media = options.webrtc({ label: frame.dataChannelLabel, audio, signal: current.signal.signal,
            onOffer(sdp) { if (active() && !current.stream?.send({ type: 'realtime.webrtc.offer', sdp })) reconnect(current, 'Voice offer could not be sent.'); },
            onData(data) { if (active() && !current.stream?.send({ type: 'realtime.webrtc.data', data })) reconnect(current, 'Voice channel overflowed.'); },
            onRemoteAudio(speaking) { if (active()) options.onStatus(speaking ? 'speaking' : 'connected'); },
            onConnectionState(state) { if (!active()) return; if (state === 'connected') { current.ready = true; connected(); flush(); } else if (state === 'disconnected') { reconnect(current, 'Voice connection ended.'); return; } options.onStatus(state); },
            onInterruption(interrupted) { if (active()) options.onStatus(interrupted ? 'connecting' : 'connected'); },
            onError(error) { if (active()) reconnect(current, error.message); },
          }).then(peer => { current.peer = peer; if (active()) peer.setMuted(muted); });
          await current.media; break;
        case 'realtime.webrtc.answer': await current.media; if (active()) await current.peer?.acceptAnswer(frame.sdp); break;
        case 'realtime.webrtc.data': await current.media; if (active() && !current.peer?.sendData(frame.data)) throw new Error('Voice channel overflowed.'); break;
        case 'realtime.audio': options.onLevel?.('output', frame.data); if (audio.player.admit(frame.data) !== 'ok') throw new Error('Voice playback could not accept audio.'); options.onStatus('speaking'); break;
        case 'realtime.audio.clear': audio.player.clear(); break;
        case 'realtime.transcript': options.onTurn(frame.role, frame.text); break;
        case 'realtime.state':
          if (frame.state === 'connecting') { current.ready = false; reset(); }
          if (frame.state === 'connected') audio.player.finish(() => { if (active()) options.onStatus('connected', frame.detail); }); else options.onStatus(frame.state, frame.detail);
          break;
        case 'realtime.closed': if (frame.retryable) reconnect(current, frame.reason); else stop(frame.reason); break;
        case 'realtime.app.request': {
          const result = await options.onAppRequest?.(frame.action, frame.target) ?? { ok: false, text: 'The app cannot answer that request.' };
          if (active() && !current.stream?.send(parseRealtimeClientFrame({ type: 'realtime.app.result', requestId: frame.requestId, ...result }))) throw new Error('App answer could not be sent.'); break;
        }
        case 'realtime.usage': options.onUsage?.(frame.usage); break;
      }
    };
    void options.open().then(stream => {
      if (!active()) { stream.close(); return; }
      current.stream = stream; audio.player.bind(stream);
      stream.onFrame(frame => { void handle(frame).catch(error => { if (active()) fail(error); }); });
      stream.onClose(reason => reconnect(current, reason)); stream.start();
    }).catch(error => { if (active()) reconnect(current, error instanceof Error ? error.message : String(error)); });
  };
  options.onStatus('connecting'); connect();
  return {
    stop,
    interrupt() { if (stopped) return; audio.player.clear(); speech.length = 0; if (!attempt?.stream?.send({ type: 'realtime.control', action: 'interrupt' })) { if (attempt) reconnect(attempt, 'Voice interruption could not be sent.'); } },
    setMuted(value: boolean) { muted = value; attempt?.peer?.setMuted(value); if (value) { mic.length = 0; micBytes = 0; } },
    speak(text: string) { if (stopped) return; const frame = parseRealtimeClientFrame({ type: 'realtime.say', text }); if (frame.type !== 'realtime.say') return; if (speech.length >= 16) { fail(new Error('Voice request buffer overflowed.')); return; } speech.push(frame.text); flush(); },
  };
}
