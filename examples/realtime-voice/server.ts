/** Explicit live demo; sign-in is kept at this computer's machine store. BYOKIT_EXAMPLE_FAKE=1 (e2e.test.ts) swaps in
 * a stand-in sign-in and a stand-in voice peer (stand-in.html) on this loopback server: nothing leaves the computer. */
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';
import { Accounts } from '../../packages/accounts/src/portable.ts';
import { machineStore } from '../../packages/accounts/src/index.ts';
import { osKeyringSeal } from '../../packages/secrets/src/index.ts';
import { realtimeEngine, toolBridge } from '../../packages/realtime/src/node.ts';
// The only environment read: the offline run never builds Accounts, so it never touches a real sign-in.
const fake = process.env.BYOKIT_EXAMPLE_FAKE === '1';
const accounts = fake ? undefined : new Accounts<any, number>({ store: (m) => machineStore(m, osKeyringSeal({ service: 'byokit' })) });
const bundle = await build({ entryPoints: [new URL('./voice.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'browser', format: 'esm' });
const page = await readFile(new URL('./index.html', import.meta.url));
const style = await readFile(new URL('./voice.css', import.meta.url));
const standIn = fake ? await readFile(new URL('./stand-in.html', import.meta.url)) : undefined;
// Stand-in signaling: the engine posts its offer with this throwaway token; stand-in.html answers it.
const standInToken = randomBytes(16).toString('hex');
let offer: { sdp: string; answer(sdp: string): void } | undefined;
const body = async (request: IncomingMessage) => { let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 64 * 1024) throw new Error('Too large'); } return text; };
let engine: ReturnType<typeof realtimeEngine> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
// Counts only. No credentials, SDP, microphone recordings or free-form transcripts in logs.
const proof = { signedIn: false, signalingAnswered: false, connected: false, microphone: false, microphoneLevel: false, outputAudio: false, userTurns: 0, agentTurns: 0, interrupted: false, stopped: false, error: false };
let origin = '';
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; media-src 'self' blob:");
  try {
    if (request.method === 'GET' && request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(page); }
    else if (request.method === 'GET' && request.url === '/voice.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); }
    else if (request.method === 'GET' && request.url === '/voice.css') { response.setHeader('Content-Type', 'text/css'); response.end(style); }
    else if (request.method === 'GET' && request.url === '/proof') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(proof)); }
    else if (standIn && request.method === 'POST' && request.url === '/login' && request.headers.origin === origin) {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ url: '/stand-in.html', code: 'STAND-IN' }));
    } else if (standIn && request.method === 'GET' && request.url === '/stand-in.html') {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'"); response.setHeader('Content-Type', 'text/html'); response.end(standIn);
    } else if (standIn && request.method === 'POST' && request.url === '/stand-in/approve' && request.headers.origin === origin) { proof.signedIn = true; response.end(); }
    else if (standIn && request.method === 'POST' && request.url === '/stand-in/offer' && request.headers.authorization === `Bearer ${standInToken}`) {
      const { sdp } = JSON.parse(await body(request));
      response.end(await new Promise<string>(resolve => { offer = { sdp, answer: resolve }; }));
    } else if (standIn && request.method === 'GET' && request.url === '/stand-in/offer') { if (offer) response.end(offer.sdp); else { response.writeHead(204); response.end(); } }
    else if (standIn && request.method === 'POST' && request.url === '/stand-in/answer' && request.headers.origin === origin && offer) {
      offer.answer(await body(request)); offer = undefined; response.end();
    } else if (accounts && request.method === 'POST' && request.url === '/login' && request.headers.origin === origin) {
      const login = await accounts.login(1, 'chatgpt', { via: 'code' });
      void accounts.finished(1, 'chatgpt').then(async () => { try { await accounts.access(1); proof.signedIn = true; } catch { proof.error = true; } });
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(login));
    } else { response.writeHead(403); response.end(); }
  } catch { response.writeHead(500); response.end('The demonstration could not start.'); }
});
const sockets = new WebSocketServer({ server, maxPayload: 128 * 1024, verifyClient: (info: { origin: string }) => info.origin === origin });
sockets.on('connection', socket => {
  if (!proof.signedIn || engine) { socket.close(); return; }
  const emit = (frame: Parameters<Parameters<typeof realtimeEngine>[0]['emit']>[0]) => {
    if (frame.type === 'realtime.webrtc.answer') proof.signalingAnswered = true;
    if (frame.type === 'realtime.transcript') frame.role === 'user' ? proof.userTurns++ : proof.agentTurns++;
    if (frame.type === 'realtime.closed') proof.stopped = true;
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };
  engine = realtimeEngine({ engine: 'chatgpt', ...(accounts ? { auth: { kind: 'plan', access: signal => accounts.access(1, signal) } }
    : { auth: { kind: 'plan', access: async () => ({ access: standInToken, accountId: 'stand-in' }) }, endpoint: `${origin}/stand-in/offer` }), instructions: "This is a short voice demo. Say only: Hello from BYOKit. Use no tools, names, personal information or other content.", bridge: toolBridge({ tools: [], handlers: {}, emit, failure: () => 'The demo cannot perform tasks.' }), emit });
  deadline = setTimeout(() => { engine?.close(); socket.close(); }, 45000);
  socket.on('message', raw => {
    try {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'demo.proof') {
        for (const key of ['connected', 'microphone', 'microphoneLevel', 'outputAudio', 'interrupted'] as const) if (frame[key] === true) proof[key] = true;
      } else engine?.receive(frame);
    } catch { proof.error = true; socket.close(); }
  });
  socket.on('close', () => { clearTimeout(deadline); engine?.close(); engine = undefined; proof.stopped = true; });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing demo address');
origin = `http://127.0.0.1:${address.port}`;
console.log(`${fake ? 'Offline stand-in demo (not a live pass)' : 'Live demo'}: ${origin}`);
const stop = () => { engine?.close(); clearTimeout(deadline); for (const socket of sockets.clients) socket.close(); sockets.close(); server.close(); void Promise.resolve(accounts?.logout(1, 'chatgpt')).finally(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
