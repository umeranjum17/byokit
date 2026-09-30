import { realtimeClient, type AudioPorts, type RealtimeStream } from '../../packages/realtime/src/index.ts';
import { webRtcPeer } from '../../packages/realtime/src/webrtc.ts';
const status = document.querySelector<HTMLOutputElement>('#status')!;
const remote = document.querySelector<HTMLAudioElement>('#audio')!;
const code = document.querySelector<HTMLElement>('#code')!;
const signIn = document.querySelector<HTMLButtonElement>('#sign-in')!;
const start = document.querySelector<HTMLButtonElement>('#start')!;
let client: ReturnType<typeof realtimeClient> | undefined, socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
let context: AudioContext | undefined;
const report = (facts: Record<string, boolean>) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'demo.proof', ...facts })); };
const audio: AudioPorts = {
  microphone: { acquire: async () => {}, release() {} }, route: async () => {}, unroute: async () => { await context?.close(); context = undefined; remote.srcObject = null; },
  capture: async () => { throw new Error('This demo uses WebRTC audio.'); },
  player: { ensure() {}, bind() {}, unbind() {}, admit: () => 'ok', clear() {}, finish: fn => { fn?.(); return true; }, afterDrain: () => false, stop() {}, release() {} },
};
signIn.onclick = async () => {
  signIn.disabled = true;
  try {
    const response = await fetch('/login', { method: 'POST' }); if (!response.ok) throw new Error();
    const login = await response.json();
    if (!login.url || !login.code) throw new Error();
    code.textContent = login.code;
    const link = document.querySelector<HTMLAnchorElement>('#authorize')!; link.href = login.url; link.hidden = false;
    status.value = 'Approve this code in your signed-in browser, then start the demo.';
  } catch { status.value = 'Sign-in could not start.'; signIn.disabled = false; }
};
start.onclick = async () => {
  if (client) return;
  const proof = await fetch('/proof').then(response => response.json());
  if (!proof.signedIn) { status.value = 'Finish sign-in first.'; return; }
  code.textContent = ''; document.querySelector<HTMLElement>('#authorize')!.hidden = true; start.disabled = true;
  client = realtimeClient({ audio,
    retryableClose: () => false, // This bounded proof records one call only.
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
        context = new AudioContext(); const analyser = context.createAnalyser(); context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const meter = () => { if (!context) return; analyser.getFloatTimeDomainData(samples); if (samples.some(value => Math.abs(value) > 0.01)) report({ microphoneLevel: true }); else requestAnimationFrame(meter); }; meter();
        return stream;
      },
    } }),
    onStatus(value) { status.value = value; },
    onTurn() {}, // Demo proof retains counts, never unrestricted speech.
  });
  timer = setTimeout(() => client?.stop(), 40000);
};
document.querySelector<HTMLButtonElement>('#interrupt')!.onclick = () => { report({ interrupted: true }); client?.interrupt(); };
document.querySelector<HTMLButtonElement>('#stop')!.onclick = () => { clearTimeout(timer); client?.stop(); client = undefined; start.disabled = false; };
window.addEventListener('pagehide', () => { clearTimeout(timer); client?.stop(); });
