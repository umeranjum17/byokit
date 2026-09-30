import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { realtimeEngine, toolBridge } from '../src/node.ts';
import { appBridge } from '../src/tools.ts';
import { realtimeClient, parseRealtimeClientFrame, parseRealtimeHostFrame, realtimePcm16ByteLength, providers, type AudioPorts, type RealtimeHostFrame, type RealtimeClientFrame, type RealtimeStream } from '../src/index.ts';
import { webRtcPeer } from '../src/webrtc.ts';
import { Accounts, memoryStore } from '../../accounts/src/portable.ts';
import { mockOpenAI } from '../../accounts/src/testing/index.ts';
import { build } from 'esbuild';
const waitFor = async (predicate: () => boolean) => {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw new Error('flow timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const tools = [{ name: 'lookup', description: 'Look up a record', parameters: { type: 'object', properties: {} } }];
for (const provider of ['openai', 'gemini', 'xai'] as const) test(`${provider}: child setup, PCM, tool round trip, turns, usage, close`, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const frames: RealtimeHostFrame[] = [], received: any[] = [];
  let socket: WebSocket | undefined, called = 0;
  server.on('connection', (ws, request) => {
    socket = ws;
    if (provider === 'gemini') assert.match(request.url!, /key=test-secret/); else assert.equal(request.headers.authorization, 'Bearer test-secret');
    ws.on('message', raw => {
      const event = JSON.parse(String(raw)); received.push(event);
      if (event.session?.instructions === 'Be brief.' || event.setup?.systemInstruction?.parts[0]?.text === 'Be brief.') {
        ws.send(JSON.stringify(provider === 'gemini' ? { setupComplete: {} } : { type: 'session.updated' }));
      }
    });
  });
  const bridge = toolBridge({ tools, emit: frame => frames.push(frame), handlers: { lookup: async (args) => { called++; assert.deepEqual(args, { person: 'Umer' }); return 'Found Umer'; } }, failure: () => 'Could not look up the record.' });
  const engine = realtimeEngine({ engine: provider, auth: { kind: 'key', key: 'test-secret' }, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, instructions: 'Be brief.', tools, bridge, emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await engine.ready;
  await waitFor(() => frames.some(frame => frame.type === 'realtime.ready'));
  assert.ok(frames.some(frame => frame.type === 'realtime.ready' && frame.inputRate === (provider === 'gemini' ? 16000 : 24000)));
  engine.receive({ type: 'realtime.audio', data: 'AAA=' });
  engine.receive({ type: 'realtime.say', text: 'Hello Umer' });
  await waitFor(() => received.some(event => event.audio || event.realtimeInput?.audio));
  const send = (value: unknown) => socket!.send(JSON.stringify(value));
  if (provider === 'gemini') {
    send({ toolCall: { functionCalls: [{ id: 'call-1', name: 'lookup', args: { person: 'Umer' } }] } });
    send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=' } }] }, inputTranscription: { text: 'Hello Umer' }, outputTranscription: { text: 'Hello' }, turnComplete: true }, usageMetadata: { promptTokenCount: 7, responseTokenCount: 3 } });
  } else {
    send({ type: 'response.created' });
    send({ type: 'response.audio.delta', delta: 'AAA=' });
    send({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello Umer' });
    send({ type: 'response.output_audio_transcript.done', transcript: 'Hello' });
    send({ type: 'response.function_call_arguments.done', response_id: 'response-1', call_id: 'call-1', name: 'lookup', arguments: '{"person":"Umer"}' });
    if (provider === 'openai') send({ type: 'response.done', response: { id: 'response-1', status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } } });
  }
  await waitFor(() => received.some(event => event.toolResponse || event.item?.type === 'function_call_output'));
  assert.equal(called, 1);
  await waitFor(() => frames.some(frame => frame.type === 'realtime.audio') && frames.some(frame => frame.type === 'realtime.transcript' && frame.role === 'agent'));
  if (provider !== 'xai') { await waitFor(() => engine.usage.inputTokens === 7); assert.equal(engine.usage.outputTokens, 3); }
  engine.close('Done'); engine.close('Duplicate');
  assert.equal(frames.filter(frame => frame.type === 'realtime.closed').length, 1);
  assert.equal(engine.usage.basis, provider === 'xai' ? 'minutes' : 'tokens');
  assert.ok(!JSON.stringify(frames).includes('test-secret'));
});
for (const provider of ['openai', 'gemini', 'xai'] as const) test(`${provider}: refusal redacts the exact key and app identifiers`, async t => {
  const key = 'literal-super-secret';
  const server = createServer((_req, response) => { response.writeHead(403); response.end(JSON.stringify({ error: { message: `key=${key} w1:t2 forbidden` } })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const frames: RealtimeHostFrame[] = [];
  const bridge = toolBridge({ tools: [], handlers: {}, emit: frame => frames.push(frame), failure: () => 'Failed' });
  const engine = realtimeEngine({ engine: provider, auth: { kind: 'key', key }, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, redact: [/w\d+:t\d+/g], bridge, emit: frame => frames.push(frame) });
  t.after(() => engine.close());
  await waitFor(() => frames.some(frame => frame.type === 'realtime.closed'));
  const output = JSON.stringify(frames); assert.ok(!output.includes(key)); assert.ok(!output.includes('w1:t2')); assert.match(output, /forbidden/);
});
test('ChatGPT: accounts sign-in, child SDP, delegation coalescing and subscription usage', async t => {
  const openai = await mockOpenAI({ email: 'umer@example.com' }); t.after(() => openai.close());
  const accounts = new Accounts<any, number>({ store: () => memoryStore(), authBase: openai.base });
  const login = (await accounts.login(1, 'chatgpt'))!; openai.approve(login.code!); await accounts.finished(1, 'chatgpt');
  const credential = await accounts.access(1);
  let body: any, headers: Record<string, string | string[] | undefined> = {}, count = 0;
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString()); headers = req.headers; res.end('v=0\r\ns=voice\r\n'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const frames: RealtimeHostFrame[] = [];
  const delegateTools = [{ name: 'delegate', description: 'Handle a request', parameters: { type: 'object' } }];
  const bridge = toolBridge({ tools: delegateTools, handlers: { delegate: async args => { count++; assert.equal(args.request, 'Find Umer'); return 'Umer is here'; } }, emit: frame => frames.push(frame), failure: () => 'Failed' });
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: signal => accounts.access(1, signal) }, instructions: 'Be brief.', tools: delegateTools, bridge, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, emit: frame => frames.push(frame) });
  t.after(() => engine.close());
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.start'));
  engine.receive({ type: 'realtime.webrtc.offer', sdp: 'v=0\r\ns=offer\r\n' });
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.answer'));
  assert.equal(headers.authorization, `Bearer ${credential.access}`); assert.equal(headers.originator, 'byokit'); assert.equal(headers['user-agent'], 'byokit'); assert.equal(body.session.instructions, 'Be brief.');
  for (const id of ['d1', 'd1', 'd2']) engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id, type: 'delegation', target: 'client', user_bidi_turn_id: 'turn1', content: [{ type: 'input_text', text: 'Find Umer' }] } }) });
  await waitFor(() => frames.filter(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append').length === 2);
  assert.equal(count, 1); engine.close(); assert.equal(engine.usage.basis, 'subscription'); assert.ok(!JSON.stringify(frames).includes(credential.access));
});
test('ChatGPT: BYOKit originator refusal, oversized SDP answer, and forbidden origins', async t => {
  let status = 403, answer = 'Refused';
  const server = createServer((_req, res) => { res.writeHead(status); res.end(answer); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  for (const mode of ['refusal', 'oversize']) {
    if (mode === 'oversize') { status = 200; answer = 'v=0' + 'a'.repeat(128 * 1024); }
    const frames: RealtimeHostFrame[] = [];
    const bridge = toolBridge({ tools: [], handlers: {}, emit: frame => frames.push(frame), failure: () => 'Failed' });
    const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'test-token', accountId: 'account1' }) }, bridge, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, emit: frame => frames.push(frame) });
    t.after(() => engine.close()); await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.start')); engine.receive({ type: 'realtime.webrtc.offer', sdp: 'v=0\r\n' });
    await waitFor(() => frames.some(frame => frame.type === 'realtime.closed'));
    if (mode === 'refusal') assert.ok(frames.some(frame => frame.type === 'realtime.closed' && frame.reason === 'not-included'));
    assert.ok(!frames.some(frame => frame.type === 'realtime.webrtc.answer'));
  }
  const bridge = toolBridge({ tools: [], handlers: {}, emit: () => {}, failure: () => 'Failed' });
  assert.throws(() => realtimeEngine({ engine: 'openai', auth: { kind: 'key', key: 'x' }, bridge, endpoint: 'https://example.com', emit: () => {} }));
});
test('Gemini cancellation crosses the child boundary and aborts the product handler', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  let socket: WebSocket | undefined, entered = false, aborted = false;
  const frames: RealtimeHostFrame[] = [];
  server.on('connection', ws => { socket = ws; ws.once('message', () => ws.send(JSON.stringify({ setupComplete: {} }))); });
  const bridge = toolBridge({ tools, handlers: { lookup: async (_args, context) => { entered = true; context.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }, emit: frame => frames.push(frame), failure: () => 'Cancelled' });
  const engine = realtimeEngine({ engine: 'gemini', auth: { kind: 'key', key: 'test-secret' }, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, tools, bridge, emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await waitFor(() => frames.some(frame => frame.type === 'realtime.ready'));
  socket!.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'cancel-1', name: 'lookup', args: {} }] } }));
  await waitFor(() => entered); socket!.send(JSON.stringify({ toolCallCancellation: { ids: ['cancel-1'] } }));
  await waitFor(() => aborted); engine.close();
});
test('tool and app bridges: dedupe, timeout, cancellation and semantic reply', async () => {
  let calls = 0, timedOut = false, aborted = false;
  const bridge = toolBridge({ tools, emit: () => {}, handlers: { lookup: async (_args, ctx) => { calls++; ctx.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }, timeoutFor: () => 10, failure: (_name, _error, timeout) => { timedOut = timeout; return 'Timed out'; } });
  const one = bridge.run('lookup', {}, 'id'); const two = bridge.run('lookup', {}, 'id'); assert.equal(one, two); assert.equal(await one, 'Timed out'); assert.equal(calls, 1); assert.equal(timedOut, true); assert.equal(aborted, true); bridge.close();
  const frames: RealtimeHostFrame[] = []; const app = appBridge(frame => { frames.push(frame); });
  const result = app.run('navigate', 'Home'); const request = frames[0]; assert.equal(request.type, 'realtime.app.request');
  if (request.type === 'realtime.app.request') app.receive({ type: 'realtime.app.result', requestId: request.requestId, ok: true, text: 'Opened Home' });
  assert.equal(await result, 'Opened Home'); app.close();
});
function audioPorts(events: string[]): AudioPorts {
  return {
    microphone: { acquire: async () => { events.push('acquire'); }, release: () => { events.push('release'); } },
    route: async () => { events.push('route'); }, unroute: async () => { events.push('unroute'); },
    capture: async () => { events.push('capture'); return { pending: ['AAA='], release: async () => { events.push('capture-release'); } }; },
    player: { ensure: () => {}, bind: () => {}, unbind: () => {}, admit: () => 'ok', clear: () => { events.push('clear'); }, finish: fn => { fn?.(); return true; }, afterDrain: () => false, stop: () => {}, release: () => {} },
  };
}
test('injected microphone and playback make a complete voice turn through the provider child', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const events: string[] = [], playback: string[] = [], turns: string[] = [];
  let capture!: (data: string) => void, microphonePackets = 0, cancelled = false;
  const audio = audioPorts(events);
  audio.capture = async (rate, onData) => {
    assert.equal(rate, 24000); events.push('capture'); capture = onData;
    return { pending: [], release: async () => { events.push('capture-release'); } };
  };
  audio.player.admit = data => { playback.push(data); return 'ok'; };
  server.on('connection', socket => socket.on('message', raw => {
    const event = JSON.parse(String(raw));
    if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
    if (event.type === 'response.cancel') cancelled = true;
    if (event.type !== 'input_audio_buffer.append') return;
    microphonePackets++; assert.equal(event.audio, 'AQABAA==');
    for (const reply of [
      { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello from BYOKit.' },
      { type: 'response.created', response: { id: 'demo-turn' } },
      { type: 'response.audio.delta', response_id: 'demo-turn', delta: 'AgACAA==' },
      { type: 'response.output_audio_transcript.done', response_id: 'demo-turn', transcript: 'Hello.' },
    ]) socket.send(JSON.stringify(reply));
  }));
  let engine: ReturnType<typeof realtimeEngine> | undefined, deliver!: (frame: RealtimeHostFrame) => void;
  const client = realtimeClient({ audio, onStatus() {}, onTurn(role, text) { turns.push(`${role}: ${text}`); }, open: async () => ({
    onFrame(fn) { deliver = fn; }, onClose() {}, send(frame) { return engine?.receive(frame) ?? false; },
    start() {
      engine = realtimeEngine({ engine: 'openai', auth: { kind: 'key', key: 'test-secret' }, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        bridge: toolBridge({ tools: [], handlers: {}, emit: frame => deliver(frame), failure: () => 'Failed' }), emit: frame => deliver(frame) });
    }, close() { engine?.close(); },
  }) });
  t.after(() => { client.stop(); engine?.close(); });
  await waitFor(() => !!capture);
  assert.deepEqual(events.filter(event => event !== 'clear').slice(0, 3), ['acquire', 'route', 'capture']);
  capture('AQABAA==');
  await waitFor(() => turns.length === 2 && playback.length === 1);
  assert.deepEqual(turns, ['user: Hello from BYOKit.', 'agent: Hello.']); assert.deepEqual(playback, ['AgACAA==']);
  client.setMuted(true); capture('AQABAA=='); client.interrupt();
  await waitFor(() => cancelled); assert.equal(microphonePackets, 1); assert.ok(events.includes('clear'));
  client.stop(); await waitFor(() => events.includes('unroute'));
  assert.equal(events.filter(event => event === 'release').length, 1); assert.ok(events.includes('capture-release'));
});
test('PCM client: microphone readiness, mute, audio, turns and stop during acquisition', async () => {
  for (const stopEarly of [false, true]) {
    const events: string[] = [], sent: RealtimeClientFrame[] = [], turns: string[] = [];
    let deliver!: (frame: RealtimeHostFrame) => void, releaseAcquire!: () => void;
    const audio = audioPorts(events); audio.microphone.acquire = () => new Promise(resolve => { events.push('acquire'); releaseAcquire = resolve; });
    const stream: RealtimeStream = { send(frame) { sent.push(frame); return true; }, onFrame(fn) { deliver = fn; }, onClose() {}, start() {}, close() {} };
    const client = realtimeClient({ open: async () => stream, audio, onStatus: () => {}, onTurn: (_role, text) => { turns.push(text); } });
    await waitFor(() => !!deliver); deliver({ type: 'realtime.ready', inputRate: 16000, outputRate: 24000 });
    await waitFor(() => !!releaseAcquire); assert.ok(!events.includes('capture')); if (stopEarly) client.stop(); releaseAcquire();
    if (!stopEarly) { await waitFor(() => events.includes('capture')); assert.deepEqual(events.slice(0, 3), ['acquire', 'route', 'capture']); client.setMuted(true); client.speak('Hello Umer'); deliver({ type: 'realtime.transcript', role: 'agent', text: 'Hello Umer' }); deliver({ type: 'realtime.audio.clear' }); assert.deepEqual(turns, ['Hello Umer']); client.stop(); }
    await waitFor(() => events.includes('release')); assert.equal(events.filter(event => event === 'release').length, 1);
  }
});
test('WebRTC: injected media ordering, one peer, bounded signaling and stop cleanup', async () => {
  const events: string[] = []; let peers = 0, stoppedTracks = 0;
  const track = { kind: 'audio', enabled: true, stop: () => { stoppedTracks++; } };
  const channel = { readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} };
  const peer = { connectionState: 'connecting', iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' }, createDataChannel: () => channel, addTrack() {}, createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  let offer = '';
  const handle = await webRtcPeer({ label: 'oai-events', audio: audioPorts(events), platform: { createPeer: () => { peers++; return peer as unknown as RTCPeerConnection; }, getUserMedia: async () => { events.push('media'); return stream as unknown as MediaStream; } }, onOffer: sdp => { offer = sdp; }, onData() {}, onRemoteAudio() {}, onConnectionState() {}, onInterruption() {}, onError(error) { throw error; } });
  assert.deepEqual(events.slice(0, 3), ['acquire', 'route', 'media']); assert.equal(peers, 1); assert.equal(offer, 'v=0\r\n');
  assert.equal(handle.sendData('a'.repeat(32769)), false); assert.equal(handle.sendData('a'.repeat(32768)), true); assert.equal(handle.sendData('a'.repeat(32768)), true); assert.equal(handle.sendData('a'), false);
  await assert.rejects(handle.acceptAnswer('x')); await handle.acceptAnswer('v=0\r\n'); handle.setMuted(true); assert.equal(track.enabled, false); handle.stop(); handle.stop(); assert.equal(stoppedTracks, 1); assert.equal(events.filter(event => event === 'release').length, 1);
});
test('portable imports and frame admission', async () => {
  const bundle = await build({ entryPoints: ['packages/realtime/src/index.ts'], bundle: true, write: false, platform: 'browser' });
  assert.ok(!bundle.outputFiles[0].text.includes('node:'));
  const native = await build({ entryPoints: ['packages/realtime/src/rn-webrtc.ts'], bundle: true, write: false, platform: 'neutral', external: ['react-native-webrtc'] });
  assert.ok(!native.outputFiles[0].text.includes('node:'));
  assert.match(native.outputFiles[0].text, /import\("react-native-webrtc"\)/);
  assert.equal(providers.find(provider => provider.id === 'chatgpt')?.planSignIn, true);
  assert.equal(realtimePcm16ByteLength('AAA='), 2); assert.throws(() => realtimePcm16ByteLength('AA=='));
  assert.throws(() => parseRealtimeClientFrame({ type: 'realtime.webrtc.offer', sdp: 'v=0' + 'x'.repeat(128 * 1024) }));
  assert.throws(() => parseRealtimeHostFrame({ type: 'realtime.usage', usage: { basis: 'tokens', seconds: 1, inputTokens: -1 } }));
});
for (const provider of ['openai', 'gemini', 'xai'] as const) test(`${provider}: interruption aborts tools, fences stale output, then admits a new turn`, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const frames: RealtimeHostFrame[] = [], received: any[] = [];
  let socket: WebSocket | undefined, entered = 0, aborted = false;
  server.on('connection', ws => { socket = ws; ws.on('message', raw => { const event = JSON.parse(String(raw)); received.push(event); if (event.setup || event.type === 'session.update') ws.send(JSON.stringify(provider === 'gemini' ? { setupComplete: {} } : { type: 'session.updated' })); }); });
  const bridge = toolBridge({ tools, handlers: { lookup: async (_args, context) => { entered++; context.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }, emit: frame => frames.push(frame), failure: () => 'Cancelled' });
  const engine = realtimeEngine({ engine: provider, auth: { kind: 'key', key: 'test-secret' }, tools, bridge, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await waitFor(() => frames.some(frame => frame.type === 'realtime.ready'));
  const send = (event: unknown) => socket!.send(JSON.stringify(event));
  if (provider === 'gemini') send({ toolCall: { functionCalls: [{ id: 'old-call', name: 'lookup', args: {} }] } });
  else {
    send({ type: 'response.created', response: { id: 'old' } });
    send({ type: 'response.function_call_arguments.done', response_id: 'old', call_id: 'old-call', name: 'lookup', arguments: '{}' });
    if (provider === 'openai') send({ type: 'response.done', response: { id: 'old', status: 'completed' } });
  }
  await waitFor(() => entered === 1);
  if (provider === 'openai') {
    send({ type: 'response.created', response: { id: 'cancellable' } });
    send({ type: 'response.audio.delta', response_id: 'cancellable', delta: 'AgACAA==' });
    await waitFor(() => frames.some(frame => frame.type === 'realtime.audio' && frame.data === 'AgACAA=='));
  }
  if (provider === 'gemini') send({ serverContent: { interrupted: true } });
  else engine.receive({ type: 'realtime.control', action: 'interrupt' });
  await waitFor(() => aborted && frames.some(frame => frame.type === 'realtime.audio.clear'));
  if (provider !== 'gemini') await waitFor(() => received.some(event => event.type === 'response.cancel'));
  if (provider === 'gemini') {
    send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=' } }] }, outputTranscription: { text: 'stale' }, turnComplete: true } });
    send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQABAA==' } }] } } });
  } else {
    send({ type: 'response.created', response: { id: 'new' } });
    send({ type: 'response.audio.delta', response_id: 'old', delta: 'AAA=' });
    send({ type: 'response.output_audio_transcript.done', response_id: 'old', transcript: 'stale' });
    send({ type: 'response.function_call_arguments.done', response_id: 'old', call_id: 'stale-call', name: 'lookup', arguments: '{}' });
    send({ type: 'response.audio.delta', response_id: 'new', delta: 'AQABAA==' });
  }
  await waitFor(() => frames.some(frame => frame.type === 'realtime.audio' && frame.data === 'AQABAA=='));
  assert.equal(entered, 1);
  assert.ok(!frames.some(frame => frame.type === 'realtime.audio' && frame.data === 'AAA='));
  assert.ok(!frames.some(frame => frame.type === 'realtime.transcript' && frame.text === 'stale'));
  assert.ok(!received.some(event => event.item?.type === 'function_call_output' || event.toolResponse));
});
for (const provider of ['openai', 'gemini', 'xai'] as const) test(`${provider}: transient disconnect has exactly two retries and no sent-input replay`, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const frames: RealtimeHostFrame[] = [], received: any[] = [], sockets: WebSocket[] = [];
  server.on('connection', ws => { sockets.push(ws); ws.on('message', raw => { const event = JSON.parse(String(raw)); received.push(event); if (event.setup || event.type === 'session.update') ws.send(JSON.stringify(provider === 'gemini' ? { setupComplete: {} } : { type: 'session.updated' })); }); });
  const bridge = toolBridge({ tools: [], handlers: {}, emit: frame => frames.push(frame), failure: () => 'Failed' });
  const engine = realtimeEngine({ engine: provider, auth: { kind: 'key', key: 'test-secret' }, bridge, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await waitFor(() => frames.some(frame => frame.type === 'realtime.ready'));
  engine.receive({ type: 'realtime.audio', data: 'AAA=' });
  await waitFor(() => received.some(event => event.audio || event.realtimeInput?.audio));
  for (let index = 0; index < 3; index++) {
    await waitFor(() => frames.filter(frame => frame.type === 'realtime.ready').length === index + 1);
    sockets[index].close(1011, 'Connection lost');
  }
  await waitFor(() => frames.some(frame => frame.type === 'realtime.closed'));
  assert.equal(sockets.length, 3); assert.equal(received.filter(event => event.audio || event.realtimeInput?.audio).length, 1);
  assert.equal(frames.filter(frame => frame.type === 'realtime.closed').length, 1);
});
test('PCM client reconnect releases a pending microphone before reopening, ignores old frames and stops retries', async () => {
  const events: string[] = [], frames: ((frame: RealtimeHostFrame) => void)[] = [], closures: ((reason?: string) => void)[] = [], sent: RealtimeClientFrame[] = [];
  let releaseAcquire!: () => void, opens = 0;
  const audio = audioPorts(events); audio.microphone.acquire = async () => { events.push('acquire'); if (opens === 1) await new Promise<void>(resolve => { releaseAcquire = resolve; }); };
  const client = realtimeClient({ open: async () => { opens++; return { send(frame) { sent.push(frame); return true; }, onFrame(fn) { frames.push(fn); }, onClose(fn) { closures.push(fn); }, start() {}, close() {} }; }, audio, onStatus() {}, onTurn() {} });
  await waitFor(() => frames.length === 1); frames[0]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 });
  await waitFor(() => !!releaseAcquire); closures[0]('Connection lost');
  assert.equal(opens, 1); releaseAcquire();
  await waitFor(() => opens === 2); assert.equal(events.filter(event => event === 'release').length, 1);
  frames[0]({ type: 'realtime.audio', data: 'AAA=' });
  frames[1]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 });
  await waitFor(() => events.includes('capture'));
  client.interrupt(); assert.ok(sent.some(frame => frame.type === 'realtime.control' && frame.action === 'interrupt'));
  closures[1]('Connection lost'); client.stop();
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(opens, 2);
  assert.equal(events.filter(event => event === 'release').length, 2);
});
test('WebRTC reconnect waits for the prior audio route to release before acquiring media again', async t => {
  const events: string[] = [], frames: ((frame: RealtimeHostFrame) => void)[] = [], closes: (() => void)[] = [];
  let opens = 0, stoppedTracks = 0, releaseRoute!: () => void;
  const audio = audioPorts(events);
  audio.unroute = async () => { events.push('unroute'); if (opens === 1) await new Promise<void>(resolve => { releaseRoute = resolve; }); };
  const client = realtimeClient({ audio, onStatus() {}, onTurn() {},
    open: async () => { opens++; return { send: () => true, onFrame(fn) { frames.push(fn); }, onClose(fn) { closes.push(() => fn('Connection lost')); }, start() {}, close() {} }; },
    webrtc: options => webRtcPeer({ ...options, platform: {
      createPeer: () => ({ connectionState: 'connecting', iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' }, createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, close() {}, send() {} }), addTrack() {}, createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {} }) as unknown as RTCPeerConnection,
      getUserMedia: async () => { events.push('media'); const track = { kind: 'audio', enabled: true, stop() { stoppedTracks++; } }; return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream; },
    } }),
  });
  t.after(() => { releaseRoute?.(); client.stop(); });
  await waitFor(() => frames.length === 1); frames[0]({ type: 'realtime.webrtc.start', dataChannelLabel: 'oai-events' });
  await waitFor(() => events.includes('media')); closes[0]();
  await waitFor(() => !!releaseRoute); await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(opens, 1); assert.equal(stoppedTracks, 1);
  releaseRoute(); await waitFor(() => opens === 2);
  frames[1]({ type: 'realtime.webrtc.start', dataChannelLabel: 'oai-events' });
  await waitFor(() => events.filter(event => event === 'media').length === 2);
  client.stop(); await waitFor(() => events.filter(event => event === 'unroute').length === 2);
  assert.equal(events.filter(event => event === 'release').length, 2); assert.equal(stoppedTracks, 2);
});
test('ChatGPT native turn interruption aborts delegation, and explicit interrupt requests fresh-call rotation', async t => {
  const frames: RealtimeHostFrame[] = []; let entered = false, aborted = false;
  const delegateTools = [{ name: 'delegate', description: 'Handle a request', parameters: { type: 'object' } }];
  const bridge = toolBridge({ tools: delegateTools, handlers: { delegate: async (_args, context) => { entered = true; context.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }, emit: frame => frames.push(frame), failure: () => 'Cancelled' });
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'test-token', accountId: 'account1' }) }, tools: delegateTools, bridge, emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.start'));
  engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id: 'old', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Demo request' }] } }) });
  await waitFor(() => entered);
  engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'turn.done', turn: { role: 'user', transcript: 'Stop please' } }) });
  await waitFor(() => aborted && frames.some(frame => frame.type === 'realtime.audio.clear'));
  engine.receive({ type: 'realtime.control', action: 'interrupt' });
  await waitFor(() => frames.some(frame => frame.type === 'realtime.closed'));
  assert.ok(frames.some(frame => frame.type === 'realtime.closed' && frame.retryable === true));
  assert.ok(!frames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append'));
});
test('client transport retries exhaust after two attempts, while normal provider close is terminal', async () => {
  let opens = 0; const statuses: string[] = [], events: string[] = [];
  const client = realtimeClient({ open: async () => { opens++; throw new Error('Connection lost'); }, audio: audioPorts(events), onStatus: status => statuses.push(status), onTurn() {} });
  await waitFor(() => statuses.includes('disconnected')); assert.equal(opens, 3); client.stop();
  let deliver!: (frame: RealtimeHostFrame) => void;
  opens = 0;
  const terminal = realtimeClient({ open: async () => { opens++; return { send: () => true, onFrame(fn) { deliver = fn; }, onClose() {}, start() {}, close() {} }; }, audio: audioPorts([]), onStatus() {}, onTurn() {} });
  await waitFor(() => !!deliver); deliver({ type: 'realtime.closed', reason: 'not-included' });
  await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(opens, 1); terminal.stop();
});
test('client restores its retry budget after thirty healthy seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frames: ((frame: RealtimeHostFrame) => void)[] = [], closes: (() => void)[] = [];
  let opens = 0;
  const client = realtimeClient({ open: async () => { opens++; return { send: () => true, onFrame(fn) { frames.push(fn); }, onClose(fn) { closes.push(() => fn('Connection lost')); }, start() {}, close() {} }; }, audio: audioPorts([]), onStatus() {}, onTurn() {} });
  t.after(() => client.stop());
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  await settle();
  for (let index = 0; index < 2; index++) {
    frames[index]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 }); await settle();
    closes[index](); await settle(); t.mock.timers.tick((index + 1) * 500); await settle();
  }
  assert.equal(opens, 3);
  frames[2]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 }); await settle();
  t.mock.timers.tick(30000); closes[2](); await settle(); t.mock.timers.tick(500); await settle();
  assert.equal(opens, 4);
});
