import { MAX_REALTIME_SDP_BYTES, MAX_REALTIME_WEBRTC_DATA_BYTES } from './frames.ts';
import type { AudioPorts } from './types.ts';
export type WebRtcHandle = { acceptAnswer(sdp: string): Promise<void>; sendData(data: string): boolean; setMuted(muted: boolean): void; stop(): void };
export type WebRtcOptions = {
  label: string; audio: Pick<AudioPorts, 'microphone' | 'route' | 'unroute'>;
  signal?: AbortSignal;
  platform?: { createPeer(): RTCPeerConnection; getUserMedia(): Promise<MediaStream> };
  onOffer(sdp: string): void; onData(data: string): void; onRemoteAudio(active: boolean): void;
  onConnectionState(state: 'connecting' | 'connected' | 'disconnected'): void;
  onInterruption(active: boolean): void; onError(error: Error): void;
};
function sdp(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('v=0') || value.includes('\0') || new TextEncoder().encode(value).length > MAX_REALTIME_SDP_BYTES) throw new Error('Invalid voice connection answer.');
  return value;
}
/** One peer per handle. Microphone permission/service readiness precedes media capture. */
export async function webRtcPeer(options: WebRtcOptions): Promise<WebRtcHandle> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.label)) throw new Error('Invalid voice channel.');
  const platform = options.platform ?? { createPeer: () => new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }), getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }) };
  let acquired = false, stopped = false, stream: MediaStream | undefined, peer: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined;
  const queue: string[] = []; let queuedBytes = 0;
  const stop = () => {
    if (stopped) return; stopped = true;
    stream?.getTracks().forEach(track => track.stop()); channel?.close(); peer?.close(); queue.length = 0;
    void options.audio.unroute().catch(() => {}); if (acquired) { options.audio.microphone.release(); acquired = false; }
    options.signal?.removeEventListener('abort', stop);
    options.onRemoteAudio(false); options.onConnectionState('disconnected');
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  const fail = (error: Error) => { if (!stopped) { options.onError(error); stop(); } };
  try {
    options.onConnectionState('connecting');
    options.signal?.throwIfAborted();
    await options.audio.microphone.acquire(); acquired = true;
    if (stopped) { options.audio.microphone.release(); acquired = false; throw new Error('Voice is closed.'); }
    await options.audio.route();
    if (stopped) { await options.audio.unroute(); throw new Error('Voice is closed.'); }
    stream = await platform.getUserMedia();
    if (stopped) { stream.getTracks().forEach(track => track.stop()); throw new Error('Voice is closed.'); }
    peer = platform.createPeer(); channel = peer.createDataChannel(options.label);
    const current = peer, dataChannel = channel;
    const flush = () => { while (!stopped && queue.length && dataChannel.readyState === 'open' && dataChannel.bufferedAmount <= 256 * 1024) { const data = queue.shift()!; queuedBytes -= new TextEncoder().encode(data).length; dataChannel.send(data); } };
    dataChannel.bufferedAmountLowThreshold = 128 * 1024;
    dataChannel.onopen = flush; dataChannel.onbufferedamountlow = flush;
    dataChannel.onmessage = event => { if (typeof event.data === 'string' && !event.data.includes('\0') && new TextEncoder().encode(event.data).length <= MAX_REALTIME_WEBRTC_DATA_BYTES && !stopped) options.onData(event.data); };
    dataChannel.onerror = () => fail(new Error('Voice channel failed.'));
    dataChannel.onclose = () => fail(new Error('Voice channel closed.'));
    current.onconnectionstatechange = () => { if (stopped) return; if (current.connectionState === 'connected') options.onConnectionState('connected'); else if (['failed', 'closed'].includes(current.connectionState)) fail(new Error('Voice connection ended.')); else options.onConnectionState('connecting'); };
    current.ontrack = event => { const track = event.track; if (track.kind !== 'audio' || stopped) return; options.onRemoteAudio(!track.muted); track.onmute = () => options.onRemoteAudio(false); track.onunmute = () => options.onRemoteAudio(true); track.onended = () => options.onRemoteAudio(false); };
    const input = stream.getAudioTracks()[0]; if (!input) throw new Error('Microphone is unavailable.');
    input.onmute = () => options.onInterruption(true); input.onunmute = () => options.onInterruption(false); input.onended = () => fail(new Error('Microphone ended.'));
    current.addTrack(input, stream);
    await current.setLocalDescription(await current.createOffer());
    if (current.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { current.onicegatheringstatechange = null; reject(new Error('Voice connection timed out.')); }, 5000);
      current.onicegatheringstatechange = () => { if (current.iceGatheringState === 'complete') { clearTimeout(timer); current.onicegatheringstatechange = null; resolve(); } };
      if (current.iceGatheringState === 'complete') { clearTimeout(timer); current.onicegatheringstatechange = null; resolve(); }
    });
    if (stopped) throw new Error('Voice is closed.');
    options.onOffer(sdp(current.localDescription?.sdp));
    return {
      async acceptAnswer(answer) { if (stopped) throw new Error('Voice is closed.'); await current.setRemoteDescription({ type: 'answer', sdp: sdp(answer) }); },
      sendData(data) {
        const bytes = new TextEncoder().encode(data).length;
        if (stopped || !bytes || bytes > MAX_REALTIME_WEBRTC_DATA_BYTES || data.includes('\0')) return false;
        if (dataChannel.readyState === 'open' && queue.length === 0) { if (dataChannel.bufferedAmount > 256 * 1024) return false; dataChannel.send(data); return true; }
        if (!['open', 'connecting'].includes(dataChannel.readyState) || queuedBytes + bytes > 64 * 1024) return false;
        queue.push(data); queuedBytes += bytes; flush(); return true;
      },
      setMuted(muted) { stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); }, stop,
    };
  } catch (error) { stop(); throw error; }
}
