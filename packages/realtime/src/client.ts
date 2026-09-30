import { parseRealtimeClientFrame, parseRealtimeHostFrame, realtimePcm16ByteLength } from './frames.ts';
import type { RealtimeHostFrame } from './frames.ts';
import type { RealtimeClientOptions, RealtimeStream } from './types.ts';
import type { WebRtcHandle } from './webrtc.ts';
/** Provider-blind device client. No reconnect or automatic barge-in policy in this lift. */
export function realtimeClient(options: RealtimeClientOptions) {
  const audio = options.audio;
  const lifetime = new AbortController();
  let stream: RealtimeStream | undefined, capture: Awaited<ReturnType<typeof audio.capture>> | undefined, peer: WebRtcHandle | undefined;
  let stopped = false, muted = false, acquired = false, ready = false;
  let mediaFlight: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const mic: { data: string; bytes: number }[] = [], speech: string[] = [];
  let micBytes = 0;
  const stats = { micCaptured: 0, micSent: 0, micQueued: 0, micDropped: 0, transportReconnects: 0, providerReconnects: 0 };
  const stop = (reason?: string) => {
    if (stopped) return; stopped = true; lifetime.abort(); clearTimeout(retry);
    stream?.send({ type: 'realtime.control', action: 'stop' });
    void capture?.release(); peer?.stop();
    if (acquired && !peer) { audio.microphone.release(); void audio.unroute().catch(() => {}); acquired = false; }
    audio.player.stop(); if (stream) audio.player.unbind(stream); audio.player.release(); stream?.close();
    mic.length = 0; speech.length = 0; options.onStats?.(stats); options.onStatus('disconnected', reason);
  };
  const fail = (error: unknown) => stop(error instanceof Error ? error.message : String(error));
  const schedule = () => { if (!retry && !stopped) retry = setTimeout(() => { retry = undefined; flush(); }, 20); };
  const flush = () => {
    if (!stream || stopped || !ready) return;
    while (mic.length) { const next = mic[0]; if (!stream.send({ type: 'realtime.audio', data: next.data })) { schedule(); return; } mic.shift(); micBytes -= next.bytes; stats.micSent++; }
    if (speech.length && audio.player.afterDrain('speech', flush)) return;
    while (speech.length) { if (!stream.send({ type: 'realtime.say', text: speech[0] })) { schedule(); return; } speech.shift(); }
  };
  const onAudio = (data: string) => {
    if (stopped || muted) return;
    try {
      const bytes = realtimePcm16ByteLength(data); stats.micCaptured++; options.onActivity?.(); options.onLevel?.('input', data);
      if (micBytes + bytes > 96000) { stats.micDropped++; throw new Error('Microphone buffer overflowed.'); }
      mic.push({ data, bytes }); micBytes += bytes; if (!ready || !stream?.send) stats.micQueued++; flush();
    } catch (error) { fail(error); }
  };
  const handle = async (raw: RealtimeHostFrame) => {
    if (stopped) return;
    const frame = parseRealtimeHostFrame(raw); options.onActivity?.();
    switch (frame.type) {
      case 'realtime.ready':
        if (mediaFlight) break;
        mediaFlight = (async () => {
          await audio.microphone.acquire(); acquired = true;
          if (stopped) { audio.microphone.release(); acquired = false; return; }
          await audio.route(); if (stopped) { await audio.unroute(); return; }
          audio.player.ensure(frame.outputRate);
          const lease = await audio.capture(frame.inputRate, onAudio); capture = lease;
          if (stopped) { await lease.release(); return; }
          ready = true; for (const data of lease.pending) onAudio(data); options.onStatus('connected'); flush();
        })();
        await mediaFlight; break;
      case 'realtime.webrtc.start':
        if (mediaFlight) break;
        if (!options.webrtc) throw new Error('Voice media is unsupported.');
        mediaFlight = options.webrtc({ label: frame.dataChannelLabel, audio, signal: lifetime.signal,
          onOffer(sdp) { if (!stream?.send({ type: 'realtime.webrtc.offer', sdp })) fail(new Error('Voice offer could not be sent.')); },
          onData(data) { if (!stream?.send({ type: 'realtime.webrtc.data', data })) fail(new Error('Voice channel overflowed.')); },
          onRemoteAudio(active) { if (!stopped) options.onStatus(active ? 'speaking' : 'connected'); },
          onConnectionState(state) { if (stopped) return; if (state === 'connected') { ready = true; flush(); } options.onStatus(state); },
          onInterruption(active) { if (!stopped) options.onStatus(active ? 'connecting' : 'connected'); }, onError: fail,
        }).then(handle => { if (stopped) handle.stop(); else { peer = handle; peer.setMuted(muted); } });
        await mediaFlight; break;
      case 'realtime.webrtc.answer': await mediaFlight; await peer?.acceptAnswer(frame.sdp); break;
      case 'realtime.webrtc.data': await mediaFlight; if (!peer?.sendData(frame.data)) throw new Error('Voice channel overflowed.'); break;
      case 'realtime.audio': options.onLevel?.('output', frame.data); if (audio.player.admit(frame.data) !== 'ok') throw new Error('Voice playback could not accept audio.'); options.onStatus('speaking'); break;
      case 'realtime.audio.clear': audio.player.clear(); break;
      case 'realtime.transcript': options.onTurn(frame.role, frame.text); break;
      case 'realtime.state': if (frame.state === 'connected') audio.player.finish(() => { if (!stopped) options.onStatus('connected', frame.detail); }); else options.onStatus(frame.state, frame.detail); break;
      case 'realtime.closed': stop(frame.reason); break;
      case 'realtime.app.request': {
        const result = await options.onAppRequest?.(frame.action, frame.target) ?? { ok: false, text: 'The app cannot answer that request.' };
        if (!stopped && !stream?.send(parseRealtimeClientFrame({ type: 'realtime.app.result', requestId: frame.requestId, ...result }))) throw new Error('App answer could not be sent.'); break;
      }
      case 'realtime.usage': options.onUsage?.(frame.usage); break;
    }
  };
  options.onStatus('connecting');
  void options.open().then(next => {
    if (stopped) { next.close(); return; } stream = next; audio.player.bind(next);
    next.onFrame(frame => { void handle(frame).catch(fail); }); next.onClose(stop); next.start();
  }).catch(fail);
  return {
    stop,
    setMuted(value: boolean) { muted = value; peer?.setMuted(value); if (value) { mic.length = 0; micBytes = 0; } },
    speak(text: string) { if (stopped) return; const frame = parseRealtimeClientFrame({ type: 'realtime.say', text }); if (frame.type !== 'realtime.say') return; if (speech.length >= 16) { fail(new Error('Voice request buffer overflowed.')); return; } speech.push(frame.text); flush(); },
  };
}
