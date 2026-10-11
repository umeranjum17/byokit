import { realtimeClient, stateWords, errorWords, type AudioPorts, type RealtimeStream } from '../../packages/realtime/src/index.ts';
import { webRtcPeer } from '../../packages/realtime/src/webrtc.ts';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screen = $('screen'), status = $<HTMLOutputElement>('status'), talk = $<HTMLButtonElement>('talk'), transcript = $<HTMLOListElement>('transcript');
const remote = $<HTMLAudioElement>('audio'), code = $('code'), signIn = $<HTMLButtonElement>('sign-in'), authorize = $<HTMLAnchorElement>('authorize');
let client: ReturnType<typeof realtimeClient> | undefined, socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
let context: AudioContext | undefined, wait: ReturnType<typeof setTimeout> | undefined;
// The call connects on the first tap with no microphone; each tap then attaches or releases it.
let calling = false, connected = false, pending = false, mic = false, awaiting = false, failed = false, cancelled = false;
let voice: 'connected' | 'thinking' | 'speaking' = 'connected';
const render = () => {
  const state = failed ? 'error' : calling && (!connected || pending) ? 'connecting' : voice === 'speaking' ? 'speaking'
    : voice === 'thinking' || awaiting ? 'thinking' : mic ? 'listening' : 'idle';
  screen.dataset.state = state;
  status.value = state === 'error' ? errorWords(undefined) : state === 'idle' ? 'Tap to talk' : stateWords({ phase: state === 'listening' ? 'connected' : state });
  talk.setAttribute('aria-pressed', String(mic)); talk.setAttribute('aria-label', mic ? 'Stop talking' : 'Talk');
};
const report = (facts: Record<string, boolean>) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'demo.proof', ...facts })); };
const audio: AudioPorts = {
  microphone: { acquire: async () => {}, release() {} }, route: async () => {}, unroute: async () => { await context?.close(); context = undefined; remote.srcObject = null; },
  capture: async () => { throw new Error('This demo streams audio over its peer connection.'); },
  player: { ensure() {}, bind() {}, unbind() {}, admit: () => 'ok', clear() {}, finish: fn => { fn?.(); return true; }, afterDrain: () => false, stop() {}, release() {} },
};
const show = () => { $('sign-in-panel').hidden = true; $('talk-panel').hidden = false; screen.dataset.state = 'idle'; render(); };
void (async () => { // The server keeps sign-in in memory; the talk screen opens once it reports one.
  while (!(await fetch('/proof').then(response => response.json()).catch(() => ({}))).signedIn) await new Promise(resolve => setTimeout(resolve, 1000));
  show();
})();
signIn.onclick = async () => {
  signIn.disabled = true;
  try {
    const response = await fetch('/login', { method: 'POST' }); if (!response.ok) throw new Error();
    const login = await response.json();
    if (!login.url || !login.code) throw new Error();
    code.textContent = login.code; authorize.href = login.url; authorize.hidden = false; signIn.hidden = true;
  } catch { code.textContent = ''; signIn.disabled = false; signIn.textContent = 'Sign-in could not start. Try again'; }
};
const end = (error: boolean) => {
  clearTimeout(timer); clearTimeout(wait); client = undefined;
  calling = connected = pending = mic = awaiting = cancelled = false; voice = 'connected'; failed = error; render();
};
const attach = async () => {
  const current = client; if (!current) return;
  cancelled = false; awaiting = false; pending = true; render();
  let attached = true;
  try { await current.attachMic(); } catch { attached = false; if (client === current) current.stop('Microphone is unavailable.'); }
  if (client !== current) return;
  mic = attached && !cancelled;
  const released = cancelled; pending = false; cancelled = false; render();
  if (released) void current.releaseMic().catch(() => { if (client === current) current.stop('Microphone could not be released.'); });
};
const call = () => {
  calling = true; pending = true; cancelled = false;
  client = realtimeClient({ audio, capture: 'lazy',
    retryableClose: () => false, // One bounded call; the next tap starts a fresh one.
    open: () => new Promise<RealtimeStream>((resolve, reject) => {
      socket = new WebSocket(location.origin.replace('http', 'ws'));
      const current = socket;
      current.onopen = () => resolve({ send(frame) { if (current.readyState !== WebSocket.OPEN || current.bufferedAmount > 512 * 1024) return false; current.send(JSON.stringify(frame)); return true; }, onFrame(fn) { current.onmessage = event => fn(JSON.parse(event.data)); }, onClose(fn) { current.onclose = () => fn('Connection ended.'); }, start() {}, close() { current.close(); } });
      current.onerror = () => reject(new Error('Connection failed.'));
    }),
    webrtc: options => webRtcPeer({ ...options, onConnectionState(state) { if (state === 'connected') report({ connected: true }); options.onConnectionState(state); }, platform: {
      createPeer() {
        const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        peer.addEventListener('track', event => {
          remote.srcObject = event.streams[0] ?? new MediaStream([event.track]); void remote.play().catch(() => {});
          event.track.addEventListener('unmute', () => report({ outputAudio: true }));
          if (!event.track.muted) report({ outputAudio: true });
        });
        return peer;
      },
      async getUserMedia() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        report({ microphone: true });
        context ??= new AudioContext(); const analyser = context.createAnalyser(); context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize), track = stream.getAudioTracks()[0];
        const meter = () => { if (!context || track?.readyState !== 'live') return; analyser.getFloatTimeDomainData(samples); if (samples.some(value => Math.abs(value) > 0.01)) report({ microphoneLevel: true }); else requestAnimationFrame(meter); }; meter();
        return stream;
      },
    } }),
    onStatus(value, reason) {
      if (value === 'disconnected') { end(reason !== undefined); return; }
      if (value === 'connecting') { render(); return; } // A muted input reads as connecting; the call itself is unchanged.
      if (!connected) { connected = true; if (pending && !cancelled) void attach(); else { pending = false; cancelled = false; } }
      if (value === 'speaking') awaiting = false;
      voice = value; render();
    },
    // Final turns show on this page only; /proof keeps counts, never text.
    onTurn(role, text) {
      if (role === 'agent') awaiting = false;
      const line = document.createElement('li'), who = document.createElement('b');
      line.className = role; who.textContent = role === 'user' ? 'You' : 'Assistant';
      line.append(who, text); transcript.append(line); line.scrollIntoView({ block: 'nearest' }); render();
    },
  });
  timer = setTimeout(() => client?.stop(), 40000);
};
talk.onclick = () => {
  if (mic) {
    mic = false; awaiting = true; clearTimeout(wait);
    wait = setTimeout(() => { awaiting = false; render(); }, 10000); // Nothing was heard: back to idle.
    render(); const current = client;
    void current?.releaseMic().catch(() => { if (client === current) current?.stop('Microphone could not be released.'); }); return;
  }
  failed = false;
  if (!client) call(); else if (pending) cancelled = true; else if (connected) void attach();
  render();
};
window.addEventListener('pagehide', () => client?.stop());
