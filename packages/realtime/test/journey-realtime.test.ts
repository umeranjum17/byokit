// Consumer journeys for the published @byokit/realtime surface, driven the way a host app uses it. Every import is a
// published entry (`@byokit/realtime`, `/node`, `/webrtc`) or the published `@byokit/accounts` and its `/testing`
// stand-in; no src, no internals. The seams are the ones the README documents: an app-supplied sign-in (`accounts`),
// an app-supplied carrier and audio implementation, an app-injected WebRTC platform, and a loopback fake standing in
// for the remote provider socket/HTTP endpoint that a real consumer also has. The security and correctness contracts
// the old unit, mock-heavy and internal cases held survive as assertions inside a journey: the provider child speaks
// to the caller's exact key (Authorization header or `?key=`), never echoes it into any frame, and a refusal redacts
// the exact credential and app request ids while keeping the provider's own wording; a non-loopback endpoint and a
// CRLF header value are refused so a plan credential cannot be exfiltrated; an interruption aborts in-flight tools and
// fences stale output; the ChatGPT plan route uses exactly the sign-in the host's `accounts.access` returns and never
// puts that token in a frame; structured delegation dispatches named targets, dedupes call ids and never reinterprets
// JSON-looking prose as permission to plan; the client owns media ordering, mute, interrupt, a bounded two-retry
// transport and never replays sent input; a lazy WebRTC call preconnects with no microphone lease; advisory auth stays
// read-only and cannot gate or close a session; and the portable entry bundles and runs for a phone with no Node.
// Session and transport correctness also survives: an expired saved sign-in refreshes while a revoked or aborted one
// refuses a token; a device offer is queued until access resolves so no signaling precedes the credential; the host
// bridge owns the tool watchdog; app phrase policy ends the call after the agent's farewell for each provider family;
// transcripts keep their full length while state details stay bounded; a carrier reconnect retains a ready recorder and
// its playback tail; speech queued while muted is sent after playback drains; and eager WebRTC orders media before
// negotiation and bounds channel data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import {
  realtimeClient, realtimeAuthCheck, realtimePcm16ByteLength, parseRealtimeClientFrame, parseRealtimeHostFrame, providers,
  type AudioPorts, type RealtimeHostFrame, type RealtimeClientFrame, type RealtimeStream,
} from '@byokit/realtime';
import { realtimeEngine, toolBridge, delegationHandler, appBridge } from '@byokit/realtime/node';
import { webRtcPeer } from '@byokit/realtime/webrtc';
import { Accounts, memoryStore, portable } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';

const waitFor = async (predicate: () => boolean) => {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw new Error('flow timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const tools = [{ name: 'lookup', description: 'Look up a record', parameters: { type: 'object', properties: {} } }];
function audioPorts(events: string[]): AudioPorts {
  return {
    microphone: { acquire: async () => { events.push('acquire'); }, release: () => { events.push('release'); } },
    route: async () => { events.push('route'); }, unroute: async () => { events.push('unroute'); },
    capture: async () => { events.push('capture'); return { pending: ['AAA='], release: async () => { events.push('capture-release'); } }; },
    player: { ensure: () => {}, bind: () => {}, unbind: () => {}, admit: () => 'ok', clear: () => { events.push('clear'); }, finish: fn => { fn?.(); return true; }, afterDrain: () => false, stop: () => {}, release: () => {} },
  };
}
const listening = (server: { once(event: 'listening', listener: () => void): unknown }) => new Promise<void>(resolve => server.once('listening', resolve));

test('a host runs a keyed voice session with each provider, the credential never escapes the child, and an interruption fences the old turn', async t => {
  for (const provider of ['openai', 'gemini', 'xai'] as const) {
    const secret = 'sk-super-secret-value';
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await listening(server); t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
    const frames: RealtimeHostFrame[] = [], received: any[] = [];
    let socket: WebSocket | undefined, called = 0;
    server.on('connection', (ws, request) => {
      socket = ws;
      // The child reaches the provider with exactly the caller's key, in the field that provider uses.
      if (provider === 'gemini') assert.match(request.url!, /key=sk-super-secret-value/); else assert.equal(request.headers.authorization, `Bearer ${secret}`);
      ws.on('message', raw => {
        const event = JSON.parse(String(raw)); received.push(event);
        if (event.session?.instructions === 'Be brief.' || event.setup?.systemInstruction?.parts[0]?.text === 'Be brief.') {
          ws.send(JSON.stringify(provider === 'gemini' ? { setupComplete: {} } : { type: 'session.updated' }));
        }
      });
    });
    const bridge = toolBridge({ tools, emit: frame => frames.push(frame), handlers: { lookup: async args => { called++; assert.deepEqual(args, { person: 'Umer' }); return 'Found Umer'; } }, failure: () => 'Could not look up the record.' });
    const engine = realtimeEngine({ engine: provider, auth: { kind: 'key', key: secret }, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, instructions: 'Be brief.', tools, bridge, emit: frame => frames.push(frame) });
    t.after(() => engine.close()); await engine.ready;
    await waitFor(() => frames.some(frame => frame.type === 'realtime.ready'));
    assert.ok(frames.some(frame => frame.type === 'realtime.ready' && frame.inputRate === (provider === 'gemini' ? 16000 : 24000)));
    engine.receive({ type: 'realtime.audio', data: 'AAA=' });
    engine.receive({ type: 'realtime.say', text: 'Hello Umer' });
    await waitFor(() => received.some(event => event.audio || event.realtimeInput?.audio));
    assert.ok(received.some(event => event.item?.content?.[0]?.text === 'Hello Umer'
      || event.clientContent?.turns?.[0]?.parts?.[0]?.text === 'Hello Umer'));
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
    // Inspect every emitted frame, including data payloads, for the exact key.
    assert.ok(!JSON.stringify(frames).includes(secret));
  }

  // A provider refusal keeps the provider's own reason but redacts the credential and app request ids.
  const key = 'literal-super-secret';
  const refusalServer = createServer((_req, response) => { response.writeHead(403); response.end(JSON.stringify({ error: { message: `key=${key} w1:t2 forbidden` } })); });
  await new Promise<void>(resolve => refusalServer.listen(0, '127.0.0.1', resolve)); t.after(() => refusalServer.close());
  const refusalFrames: RealtimeHostFrame[] = [];
  const refusalBridge = toolBridge({ tools: [], handlers: {}, emit: frame => refusalFrames.push(frame), failure: () => 'Failed' });
  const refused = realtimeEngine({ engine: 'openai', auth: { kind: 'key', key }, endpoint: `ws://127.0.0.1:${(refusalServer.address() as AddressInfo).port}`, redact: [/w\d+:t\d+/g], bridge: refusalBridge, emit: frame => refusalFrames.push(frame) });
  t.after(() => refused.close());
  await waitFor(() => refusalFrames.some(frame => frame.type === 'realtime.closed'));
  const output = JSON.stringify(refusalFrames);
  assert.ok(!output.includes(key)); assert.ok(!output.includes('w1:t2')); assert.match(output, /forbidden/);

  // A non-loopback endpoint is refused outright, so a plan credential cannot be sent to an attacker's host.
  const scratchBridge = toolBridge({ tools: [], handlers: {}, emit: () => {}, failure: () => 'Failed' });
  assert.throws(() => realtimeEngine({ engine: 'openai', auth: { kind: 'key', key: 'x' }, bridge: scratchBridge, endpoint: 'https://example.com', emit: () => {} }));

  // An interruption aborts the in-flight tool and fences output from the retired turn.
  for (const provider of ['openai', 'gemini', 'xai'] as const) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await listening(server); t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
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
  }

  // Gemini's provider-side tool cancellation crosses the child boundary and aborts the product handler.
  const cancelServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await listening(cancelServer); t.after(() => { for (const client of cancelServer.clients) client.terminate(); cancelServer.close(); });
  const cancelFrames: RealtimeHostFrame[] = [];
  let cancelSocket: WebSocket | undefined, cancelEntered = false, cancelAborted = false;
  cancelServer.on('connection', ws => { cancelSocket = ws; ws.once('message', () => ws.send(JSON.stringify({ setupComplete: {} }))); });
  const cancelBridge = toolBridge({ tools, handlers: { lookup: async (_args, context) => { cancelEntered = true; context.signal.addEventListener('abort', () => { cancelAborted = true; }); return new Promise(() => {}); } }, emit: frame => cancelFrames.push(frame), failure: () => 'Cancelled' });
  const cancelEngine = realtimeEngine({ engine: 'gemini', auth: { kind: 'key', key: 'test-secret' }, endpoint: `ws://127.0.0.1:${(cancelServer.address() as AddressInfo).port}`, tools, bridge: cancelBridge, emit: frame => cancelFrames.push(frame) });
  t.after(() => cancelEngine.close()); await waitFor(() => cancelFrames.some(frame => frame.type === 'realtime.ready'));
  cancelSocket!.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'cancel-1', name: 'lookup', args: {} }] } }));
  await waitFor(() => cancelEntered); cancelSocket!.send(JSON.stringify({ toolCallCancellation: { ids: ['cancel-1'] } }));
  await waitFor(() => cancelAborted);

  // App phrase policy ends the call after the agent's farewell for each provider family.
  for (const provider of ['chatgpt', 'openai', 'gemini', 'xai'] as const) {
    const hangupFrames: RealtimeHostFrame[] = []; let hangupSocket: WebSocket | undefined;
    const hangupServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await listening(hangupServer); t.after(() => { for (const ws of hangupServer.clients) ws.terminate(); hangupServer.close(); });
    hangupServer.on('connection', ws => { hangupSocket = ws; ws.once('message', () => ws.send(JSON.stringify(provider === 'gemini' ? { setupComplete: {} } : { type: 'session.updated' }))); });
    const hangup = realtimeEngine({ engine: provider,
      auth: provider === 'chatgpt' ? { kind: 'plan', access: async () => ({ access: 'fake-token', accountId: 'fake-account' }) } : { kind: 'key', key: 'fake-key' },
      ...(provider === 'chatgpt' ? {} : { endpoint: `ws://127.0.0.1:${(hangupServer.address() as AddressInfo).port}` }),
      hangup: text => text === 'Goodbye', bridge: toolBridge({ tools: [], handlers: {}, emit: frame => hangupFrames.push(frame), failure: () => 'Failed' }), emit: frame => hangupFrames.push(frame) });
    t.after(() => hangup.close()); await hangup.ready;
    if (provider !== 'chatgpt') await waitFor(() => hangupFrames.some(frame => frame.type === 'realtime.ready'));
    const turn = (role: 'user' | 'agent', text: string) => {
      if (provider === 'chatgpt') hangup.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'turn.done', turn: { role: role === 'agent' ? 'assistant' : 'user', transcript: text } }) });
      else if (provider === 'gemini') hangupSocket!.send(JSON.stringify({ serverContent: { [role === 'user' ? 'inputTranscription' : 'outputTranscription']: { text }, turnComplete: true } }));
      else {
        if (role === 'agent') hangupSocket!.send(JSON.stringify({ type: 'response.created', response: { id: 'farewell' } }));
        hangupSocket!.send(JSON.stringify({ type: role === 'user' ? 'conversation.item.input_audio_transcription.completed' : 'response.output_audio_transcript.done', response_id: 'farewell', transcript: text }));
      }
    };
    turn('user', 'Goodbye'); await waitFor(() => hangupFrames.some(frame => frame.type === 'realtime.transcript' && frame.role === 'user'));
    assert.ok(!hangupFrames.some(frame => frame.type === 'realtime.closed'));
    turn('agent', 'Goodbye, see you later.'); await waitFor(() => hangupFrames.some(frame => frame.type === 'realtime.closed'));
    assert.ok(hangupFrames.some(frame => frame.type === 'realtime.transcript' && frame.role === 'agent'));
    assert.deepEqual(hangupFrames.filter(frame => frame.type === 'realtime.closed'), [{ type: 'realtime.closed', reason: 'ended' }]);
  }

  // Transcripts keep their full length while state details stay bounded and every frame passes admission.
  const longServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await listening(longServer); t.after(() => { for (const ws of longServer.clients) ws.terminate(); longServer.close(); });
  const longFrames: RealtimeHostFrame[] = []; let longSocket!: WebSocket;
  longServer.on('connection', ws => { longSocket = ws; ws.once('message', () => ws.send(JSON.stringify({ type: 'session.updated' }))); });
  const longEngine = realtimeEngine({ engine: 'openai', auth: { kind: 'key', key: 'fake-key' }, endpoint: `ws://127.0.0.1:${(longServer.address() as AddressInfo).port}`,
    bridge: toolBridge({ tools: [], handlers: {}, emit() {}, failure: () => 'Failed' }), emit: frame => longFrames.push(frame) });
  t.after(() => longEngine.close()); await waitFor(() => longFrames.some(frame => frame.type === 'realtime.ready'));
  const transcript = 'A'.repeat(2000);
  longSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'long' } }));
  longSocket.send(JSON.stringify({ type: 'response.output_audio_transcript.done', response_id: 'long', transcript }));
  longSocket.send(JSON.stringify({ type: 'error', error: { message: '界'.repeat(200) } }));
  await waitFor(() => longFrames.some(frame => frame.type === 'realtime.state' && !!frame.detail));
  assert.ok(longFrames.some(frame => frame.type === 'realtime.transcript' && frame.text === transcript));
  for (const frame of longFrames) { parseRealtimeHostFrame(frame); if (frame.type === 'realtime.state' && frame.detail) assert.ok(Buffer.byteLength(frame.detail) <= 500); }
  assert.ok(!longFrames.some(frame => frame.type === 'realtime.closed'));
});

test('a person signs in with ChatGPT and delegates to a named action without leaking the plan token', async t => {
  // The host signs in through accounts; the kit uses exactly the token that sign-in yields.
  const openai = await mockOpenAI({ email: 'umer@example.com' }); t.after(() => openai.close());
  const store = memoryStore();
  const accounts = new Accounts<any, number>({ store: () => store, authBase: openai.base, app: 'byokit journey' }, portable);
  await assert.rejects(accounts.access(2), 'a member who never signed in has no access');
  const login = (await accounts.login(1, 'chatgpt'))!; openai.approve(login.code!); await accounts.finished(1, 'chatgpt');
  const credential = await accounts.access(1); assert.equal(credential.accountId, 'acct-1');

  let body: any, headers: Record<string, string | string[] | undefined> = {};
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString()); headers = request.headers; response.end('v=0\r\ns=voice\r\n'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const frames: RealtimeHostFrame[] = [];
  let count = 0;
  const delegateTools = [{ name: 'delegate', description: 'Handle a request', parameters: { type: 'object' } }];
  const bridge = toolBridge({ tools: delegateTools, handlers: { delegate: async args => { count++; assert.equal(args.request, 'Find Umer'); return 'Umer is here'; } }, emit: frame => frames.push(frame), failure: () => 'Failed' });
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: signal => accounts.access(1, signal) }, instructions: 'Be brief.', tools: delegateTools, bridge, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, emit: frame => frames.push(frame) });
  t.after(() => engine.close());
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.start'));
  engine.receive({ type: 'realtime.webrtc.offer', sdp: 'v=0\r\ns=offer\r\n' });
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.answer'));
  // The plan token, the byokit signaling identity and the app instructions reach the signaling endpoint.
  assert.equal(headers.authorization, `Bearer ${credential.access}`); assert.equal(headers.originator, 'byokit'); assert.equal(headers['user-agent'], 'byokit'); assert.equal(body.session.instructions, 'Be brief.');
  // Retransmitted delegation ids dedupe to one handler call and two context appends.
  for (const id of ['d1', 'd1', 'd2']) engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id, type: 'delegation', target: 'client', user_bidi_turn_id: 'turn1', content: [{ type: 'input_text', text: 'Find Umer' }] } }) });
  await waitFor(() => frames.filter(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append').length === 2);
  assert.equal(count, 1); engine.close(); assert.equal(engine.usage.basis, 'subscription');
  assert.ok(!JSON.stringify(frames).includes(credential.access));

  // An expired saved sign-in refreshes; a revoked or aborted one refuses to hand over a token.
  await store.modify('openai-codex', async value => value?.type === 'oauth' ? { ...value, expires: 0 } : value);
  const refreshed = await accounts.access(1); assert.notEqual(refreshed.access, credential.access);
  await store.modify('openai-codex', async value => value?.type === 'oauth' ? { ...value, expires: 0 } : value);
  openai.state.refuse = true; await assert.rejects(accounts.access(1));
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(accounts.access(1, aborted.signal));
  await accounts.logout(1, 'chatgpt'); await assert.rejects(accounts.access(1));

  // A credential failure is reported with the app's plain wording and never carries the secret.
  for (const custom of [false, true]) {
    const failureFrames: RealtimeHostFrame[] = [];
    const failing = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => { throw new Error('Sign in again from Settings. token=secret-value'); } },
      ...(custom ? { authFailure: () => 'The saved sign-in expired; sign in from Settings.' } : {}),
      bridge: toolBridge({ tools: [], handlers: {}, emit: () => {}, failure: () => 'Failed' }), emit: frame => failureFrames.push(frame) });
    await failing.ready; failing.close();
    const closed = failureFrames.find(frame => frame.type === 'realtime.closed');
    assert.equal(closed?.type, 'realtime.closed');
    if (closed?.type === 'realtime.closed') assert.match(closed.reason!, custom ? /The saved sign-in expired/ : /Sign in again from Settings/);
    assert.ok(!JSON.stringify(failureFrames).includes('secret-value'));
  }

  // A CRLF in the app's signaling identity is refused before any request is made.
  const scratch = toolBridge({ tools: [], handlers: {}, emit: () => {}, failure: () => 'Failed' });
  assert.throws(() => realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'x', accountId: 'x' }) },
    signalingIdentity: { originator: 'bad\r\nheader' }, bridge: scratch, emit: () => {} }), /protocol/);

  // The signaling endpoint's refusal is reported as not-included, and an oversized answer is never delivered.
  let status = 403, answer = 'Refused';
  const signaling = createServer((_request, response) => { response.writeHead(status); response.end(answer); });
  await new Promise<void>(resolve => signaling.listen(0, '127.0.0.1', resolve)); t.after(() => signaling.close());
  for (const mode of ['refusal', 'oversize']) {
    if (mode === 'oversize') { status = 200; answer = 'v=0' + 'a'.repeat(128 * 1024); }
    const modeFrames: RealtimeHostFrame[] = [];
    const modeEngine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'test-token', accountId: 'account1' }) },
      endpoint: `http://127.0.0.1:${(signaling.address() as AddressInfo).port}`, bridge: toolBridge({ tools: [], handlers: {}, emit: frame => modeFrames.push(frame), failure: () => 'Failed' }), emit: frame => modeFrames.push(frame) });
    t.after(() => modeEngine.close());
    await waitFor(() => modeFrames.some(frame => frame.type === 'realtime.webrtc.start'));
    modeEngine.receive({ type: 'realtime.webrtc.offer', sdp: 'v=0\r\n' });
    await waitFor(() => modeFrames.some(frame => frame.type === 'realtime.closed'));
    if (mode === 'refusal') assert.ok(modeFrames.some(frame => frame.type === 'realtime.closed' && frame.reason === 'not-included'));
    assert.ok(!modeFrames.some(frame => frame.type === 'realtime.webrtc.answer'));
  }

  // The host bridge owns the tool watchdog: a timeout becomes the app's failure wording in the child.
  const watchdogFrames: RealtimeHostFrame[] = []; let timedOut = false;
  const watchdogBridge = toolBridge({ tools: delegateTools, timeoutFor: name => { assert.equal(name, 'delegate'); return 20; },
    handlers: { delegate: async () => new Promise(() => {}) }, emit: frame => watchdogFrames.push(frame),
    failure: (_name, _error, timeout) => { timedOut = timeout; return 'The action is unconfirmed; do not repeat it.'; } });
  const watchdog = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'fake-token', accountId: 'fake-account' }) }, tools: delegateTools, bridge: watchdogBridge, emit: frame => watchdogFrames.push(frame) });
  t.after(() => watchdog.close()); await watchdog.ready;
  watchdog.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id: 'timeout', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Perform the action' }] } }) });
  await waitFor(() => watchdogFrames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append'));
  assert.equal(timedOut, true);
  assert.ok(watchdogFrames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).content?.[0]?.text === 'The action is unconfirmed; do not repeat it.'));

  // A device offer is queued until access resolves, so no signaling request precedes the credential.
  const earlyFrames: RealtimeHostFrame[] = []; let resolveAccess!: (value: { access: string; accountId: string }) => void, earlyRequests = 0, earlyHeaders: any;
  const earlyServer = createServer(async (request, response) => { earlyRequests++; earlyHeaders = request.headers; const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).sdp, 'v=0\r\ns=early\r\n'); response.end('v=0\r\ns=answer\r\n'); });
  await new Promise<void>(resolve => earlyServer.listen(0, '127.0.0.1', resolve)); t.after(() => earlyServer.close());
  const early = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: () => new Promise(resolve => { resolveAccess = resolve; }) },
    signalingIdentity: { originator: 'voice-app', userAgent: 'voice-app/1' }, endpoint: `http://127.0.0.1:${(earlyServer.address() as AddressInfo).port}`,
    bridge: toolBridge({ tools: [], handlers: {}, emit: frame => earlyFrames.push(frame), failure: () => 'Failed' }), emit: frame => earlyFrames.push(frame) });
  t.after(() => early.close());
  assert.equal(earlyFrames.filter(frame => frame.type === 'realtime.webrtc.start').length, 1);
  early.receive({ type: 'realtime.webrtc.offer', sdp: 'v=0\r\ns=early\r\n' }); assert.equal(earlyRequests, 0);
  resolveAccess({ access: 'fake-token', accountId: 'fake-account' }); await early.ready;
  await waitFor(() => earlyFrames.some(frame => frame.type === 'realtime.webrtc.answer'));
  assert.equal(earlyRequests, 1); assert.equal(earlyHeaders.originator, 'voice-app'); assert.equal(earlyHeaders['user-agent'], 'voice-app/1'); assert.equal(earlyHeaders.authorization, 'Bearer fake-token');

  // An ordinary ChatGPT user turn preserves an unfinished delegation; an explicit interrupt aborts and rotates it.
  const turnFrames: RealtimeHostFrame[] = []; let turnEntered = false, turnAborted = false;
  const turnBridge = toolBridge({ tools: delegateTools, handlers: { delegate: async (_args, context) => { turnEntered = true; context.signal.addEventListener('abort', () => { turnAborted = true; }); return new Promise(() => {}); } }, emit: frame => turnFrames.push(frame), failure: () => 'Cancelled' });
  const turnEngine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'test-token', accountId: 'account1' }) }, tools: delegateTools, bridge: turnBridge, emit: frame => turnFrames.push(frame) });
  t.after(() => turnEngine.close()); await waitFor(() => turnFrames.some(frame => frame.type === 'realtime.webrtc.start'));
  turnEngine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id: 'old', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Demo request' }] } }) });
  await waitFor(() => turnEntered);
  turnEngine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'turn.done', turn: { role: 'user', transcript: 'Stop please' } }) });
  await waitFor(() => turnFrames.some(frame => frame.type === 'realtime.audio.clear'));
  assert.equal(turnAborted, false);
  turnEngine.receive({ type: 'realtime.control', action: 'interrupt' });
  await waitFor(() => turnFrames.some(frame => frame.type === 'realtime.closed'));
  assert.equal(turnAborted, true);
  assert.ok(turnFrames.some(frame => frame.type === 'realtime.closed' && frame.retryable === true));
  assert.ok(!turnFrames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append'));

  // Structured delegation dispatches a named action, dedupes by call id, and never plans JSON-looking prose.
  const delegated: string[] = []; let plans = 0;
  const actions = [{ name: 'message', description: 'Send an authorized message to a named target', parameters: { type: 'object', properties: { agent: { type: 'string' }, text: { type: 'string' } }, required: ['agent', 'text'] } }];
  const frames2: RealtimeHostFrame[] = [];
  const actionBridge = toolBridge({ tools: actions, handlers: { message: async args => { assert.deepEqual(args, { agent: 'Avery', text: 'Please report progress' }); delegated.push('queued'); return 'Queued for Avery'; } }, emit: frame => frames2.push(frame), failure: () => 'Failed' });
  const delegate = delegationHandler({ bridge: actionBridge, plan: async request => { plans++; return `Clarify: ${request}`; } });
  const outerBridge = toolBridge({ tools: delegateTools, handlers: { delegate }, emit: frame => frames2.push(frame), failure: () => 'Failed' });
  const engine2 = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'fake-token', accountId: 'fake-account' }) }, tools: delegateTools, bridge: outerBridge, emit: frame => frames2.push(frame) });
  t.after(() => { engine2.close(); actionBridge.close(); });
  await waitFor(() => frames2.some(frame => frame.type === 'realtime.webrtc.start'));
  const request = JSON.stringify({ name: 'message', arguments: { agent: 'Avery', text: 'Please report progress' } });
  for (const id of ['s1', 's1', 's2']) engine2.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id, type: 'delegation', target: 'client', user_bidi_turn_id: 'same-turn', content: [{ type: 'input_text', text: request }] } }) });
  await waitFor(() => frames2.filter(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append').length === 2);
  assert.deepEqual(delegated, ['queued']); assert.equal(plans, 0);
  engine2.receive({ type: 'realtime.say', text: 'Host confirms Avery has finished the task.' });
  await waitFor(() => frames2.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'session.context.append'));
  assert.ok(frames2.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).content?.[0]?.text === 'Host confirms Avery has finished the task.'));
  const context = { id: 'direct', signal: new AbortController().signal };
  for (const invalid of ['{"name":', '{"name":"shell","arguments":{}}', '{"name":"message","arguments":null}', '{"name":"delegate","arguments":{}}']) {
    assert.match(await delegate({ request: invalid }, context), /invalid/);
  }
  assert.equal(plans, 0); assert.deepEqual(delegated, ['queued']);
  assert.equal(await delegate({ request: 'Which agent should receive this?' }, context), 'Clarify: Which agent should receive this?');
  assert.equal(plans, 1);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(delegate({ request }, { id: 'cancel', signal: cancel.signal }));
  assert.deepEqual(delegated, ['queued']);
});

test('the phone client carries a complete voice turn and round-trips a semantic app request', async t => {
  // A host app injects its own carrier and audio ports; the client owns media ordering, mute and release.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await listening(server); t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
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

  // A semantic app tool request crosses the client and provider child and answers through the same bridge.
  const appServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await listening(appServer); t.after(() => { for (const socket of appServer.clients) socket.terminate(); appServer.close(); });
  const replies: string[] = [];
  appServer.on('connection', socket => socket.on('message', raw => {
    const event = JSON.parse(String(raw));
    if (event.type === 'session.update') {
      for (const reply of [
        { type: 'session.updated' }, { type: 'response.created', response: { id: 'app-turn' } },
        { type: 'response.function_call_arguments.done', response_id: 'app-turn', call_id: 'app-call', name: 'navigate', arguments: '{"target":"Home"}' },
        { type: 'response.done', response: { id: 'app-turn', status: 'completed' } },
      ]) socket.send(JSON.stringify(reply));
    }
    if (event.item?.type === 'function_call_output') replies.push(event.item.output);
  }));
  let appEngine!: ReturnType<typeof realtimeEngine>, appDeliver!: (frame: RealtimeHostFrame) => void;
  const app = appBridge(frame => appDeliver(frame));
  const appTools = [{ name: 'navigate', description: 'Open a semantic destination', parameters: { type: 'object' } }];
  const appToolBridge = toolBridge({ tools: appTools, app, handlers: { navigate: (args, ctx) => app.run('navigate', String(args.target), ctx.signal) }, emit: frame => appDeliver(frame), failure: () => 'Failed' });
  const appClient = realtimeClient({ audio: audioPorts([]), onStatus() {}, onTurn() {},
    onAppRequest: async (action, target) => { assert.equal(action, 'navigate'); assert.equal(target, 'Home'); return { ok: true, text: 'Opened Home' }; },
    open: async () => ({ onFrame(fn) { appDeliver = fn; }, onClose() {}, send(frame) { return appEngine.receive(frame); },
      start() { appEngine = realtimeEngine({ engine: 'openai', auth: { kind: 'key', key: 'fake-secret' }, tools: appTools, bridge: appToolBridge,
        endpoint: `ws://127.0.0.1:${(appServer.address() as AddressInfo).port}`, emit: frame => appDeliver(frame) }); }, close() { appEngine?.close(); } }),
  });
  t.after(() => { appClient.stop(); appEngine?.close(); });
  await waitFor(() => replies.length === 1); assert.deepEqual(replies, ['Opened Home']);
  const pending = app.run('view'); appEngine.close();
  assert.equal(await pending, 'The app request was cancelled.');
});

test('the client transport retries exactly twice without replaying input, then recovers its budget', async t => {
  // A transport that never opens is retried twice (500ms, 1000ms), then the call ends disconnected.
  let opens = 0; const statuses: string[] = [], retryEvents: string[] = [];
  const retrying = realtimeClient({ open: async () => { opens++; throw new Error('Connection lost'); }, audio: audioPorts(retryEvents), onStatus: status => statuses.push(status), onTurn() {} });
  await waitFor(() => statuses.includes('disconnected')); assert.equal(opens, 3); retrying.stop();

  // A normal provider close is terminal: it is never retried.
  let deliver!: (frame: RealtimeHostFrame) => void;
  opens = 0;
  const terminal = realtimeClient({ open: async () => { opens++; return { send: () => true, onFrame(fn) { deliver = fn; }, onClose() {}, start() {}, close() {} }; }, audio: audioPorts([]), onStatus() {}, onTurn() {} });
  await waitFor(() => !!deliver); deliver({ type: 'realtime.closed', reason: 'not-included' });
  await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(opens, 1); terminal.stop();

  // A carrier drop releases the pending microphone before reopening, ignores old frames, and stops on demand.
  const events: string[] = [], frames: ((frame: RealtimeHostFrame) => void)[] = [], closures: ((reason?: string) => void)[] = [], sent: RealtimeClientFrame[] = [];
  let releaseAcquire!: () => void, reopens = 0;
  const audio = audioPorts(events); audio.microphone.acquire = async () => { events.push('acquire'); if (reopens === 1) await new Promise<void>(resolve => { releaseAcquire = resolve; }); };
  const reconnecting = realtimeClient({ open: async () => { reopens++; return { send(frame) { sent.push(frame); return true; }, onFrame(fn) { frames.push(fn); }, onClose(fn) { closures.push(fn); }, start() {}, close() {} }; }, audio, onStatus() {}, onTurn() {} });
  await waitFor(() => frames.length === 1); frames[0]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 });
  await waitFor(() => !!releaseAcquire); closures[0]('Connection lost');
  assert.equal(reopens, 1); releaseAcquire();
  await waitFor(() => reopens === 2); assert.equal(events.filter(event => event === 'release').length, 1);
  // A frame from the retired carrier is ignored; the fresh carrier restores capture and interrupts.
  frames[0]({ type: 'realtime.audio', data: 'AAA=' });
  frames[1]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 });
  await waitFor(() => events.includes('capture'));
  reconnecting.interrupt(); assert.ok(sent.some(frame => frame.type === 'realtime.control' && frame.action === 'interrupt'));
  closures[1]('Connection lost'); reconnecting.stop();
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(reopens, 2);
  assert.equal(events.filter(event => event === 'release').length, 2);

  // Thirty healthy seconds restore the retry budget, so a later drop retries again.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const healthyFrames: ((frame: RealtimeHostFrame) => void)[] = [], healthyCloses: (() => void)[] = [];
  let healthyOpens = 0;
  const healthy = realtimeClient({ open: async () => { healthyOpens++; return { send: () => true, onFrame(fn) { healthyFrames.push(fn); }, onClose(fn) { healthyCloses.push(() => fn('Connection lost')); }, start() {}, close() {} }; }, audio: audioPorts([]), onStatus() {}, onTurn() {} });
  t.after(() => healthy.stop());
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  await settle();
  for (let index = 0; index < 2; index++) {
    healthyFrames[index]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 }); await settle();
    healthyCloses[index](); await settle(); t.mock.timers.tick((index + 1) * 500); await settle();
  }
  assert.equal(healthyOpens, 3);
  healthyFrames[2]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 }); await settle();
  t.mock.timers.tick(30000); healthyCloses[2](); await settle(); t.mock.timers.tick(500); await settle();
  assert.equal(healthyOpens, 4);

  // Opt-in carrier reconnect retains a ready PCM recorder and its playback tail, and releases exactly once.
  const retainedEvents: string[] = [], retainedFrames: ((frame: RealtimeHostFrame) => void)[] = [], retainedCloses: (() => void)[] = [], retainedSent: RealtimeClientFrame[][] = [];
  let retainedCapture!: (data: string) => void;
  const retainedAudio = audioPorts(retainedEvents);
  retainedAudio.capture = async (_rate, fn) => { retainedEvents.push('capture'); retainedCapture = fn; return { pending: [], release: async () => { retainedEvents.push('capture-release'); } }; };
  const retained = realtimeClient({ audio: retainedAudio, preserveMediaOnReconnect: true, onStatus() {}, onTurn() {}, open: async () => {
    const output: RealtimeClientFrame[] = []; retainedSent.push(output);
    return { onFrame(fn) { retainedFrames.push(fn); }, onClose(fn) { retainedCloses.push(() => fn('carrier lost')); }, start() {}, close() {}, send(frame) { output.push(frame); return true; } };
  } });
  t.after(() => retained.stop());
  await settle(); retainedFrames[0]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 }); await settle();
  retainedCapture('AAA='); retainedCloses[0](); retainedCapture('AgACAA==');
  assert.ok(!retainedEvents.includes('clear')); assert.ok(!retainedEvents.includes('release')); assert.ok(!retainedEvents.includes('capture-release'));
  await settle(); t.mock.timers.tick(500); await settle();
  retainedFrames[1]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 }); await settle();
  retainedCapture('AQABAA==');
  assert.equal(retainedEvents.filter(value => value === 'acquire').length, 1); assert.equal(retainedEvents.filter(value => value === 'capture').length, 1);
  assert.deepEqual(retainedSent[1], [{ type: 'realtime.audio', data: 'AQABAA==' }]);
  retainedCloses[1](); retained.stop(); await settle();
  assert.equal(retainedEvents.filter(value => value === 'release').length, 1); assert.equal(retainedEvents.filter(value => value === 'capture-release').length, 1);
  assert.equal(retainedEvents.filter(value => value === 'unroute').length, 1);
  t.mock.timers.tick(2000); await settle(); assert.equal(retainedSent.length, 2);
});

test('a lazy WebRTC call preconnects with no microphone, attaches on demand and reconnects cleanly', async t => {
  // React Native's AbortSignal has no throwIfAborted; the lazy path must not rely on it.
  const NativeController = AbortController;
  t.mock.method(globalThis, 'AbortController', function () {
    const controller = new NativeController();
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    return controller;
  });
  // An eager peer acquires the microphone, orders media before negotiation, and bounds channel data.
  const eagerEvents: string[] = []; let peers = 0, eagerStopped = 0;
  const eagerTrack = { kind: 'audio', enabled: true, stop: () => { eagerStopped++; } };
  const eagerChannel = { readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} };
  const eagerPeer = { connectionState: 'connecting', iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' }, createDataChannel: () => eagerChannel, addTrack() {}, createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {} };
  const eagerStream = { getAudioTracks: () => [eagerTrack], getTracks: () => [eagerTrack] };
  let offer = '';
  const eager = await webRtcPeer({ label: 'oai-events', audio: audioPorts(eagerEvents), platform: { createPeer: () => { peers++; return eagerPeer as unknown as RTCPeerConnection; }, getUserMedia: async () => { eagerEvents.push('media'); return eagerStream as unknown as MediaStream; } }, onOffer: sdp => { offer = sdp; }, onData() {}, onRemoteAudio() {}, onConnectionState() {}, onInterruption() {}, onError(error) { throw error; } });
  assert.deepEqual(eagerEvents.slice(0, 3), ['acquire', 'route', 'media']); assert.equal(peers, 1); assert.equal(offer, 'v=0\r\n');
  assert.equal(eager.sendData('a'.repeat(32769)), false); assert.equal(eager.sendData('a'.repeat(32768)), true); assert.equal(eager.sendData('a'.repeat(32768)), true); assert.equal(eager.sendData('a'), false);
  await assert.rejects(eager.acceptAnswer('x')); await eager.acceptAnswer('v=0\r\n'); eager.setMuted(true); assert.equal(eagerTrack.enabled, false); eager.stop(); eager.stop(); assert.equal(eagerStopped, 1); assert.equal(eagerEvents.filter(event => event === 'release').length, 1);

  // Speech queued while muted is held until playback drains, then sent once audio clears.
  const speechEvents: string[] = [], speechSent: RealtimeClientFrame[] = [], speechStatuses: string[] = [];
  let speechDeliver!: (frame: RealtimeHostFrame) => void, blocked = false, afterDrain: (() => void) | undefined;
  const speechAudio = audioPorts(speechEvents);
  speechAudio.player.finish = () => false;
  speechAudio.player.afterDrain = (_kind, fn) => { if (!blocked) return false; afterDrain = fn; return true; };
  speechAudio.player.clear = () => { blocked = false; afterDrain = undefined; };
  const speechTrack = { kind: 'audio', enabled: true, stop() { speechEvents.push('track-stop'); } };
  const speechPeer: any = { connectionState: 'connecting', iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' },
    createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }), addTrack() {},
    createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {} };
  const speechClient = realtimeClient({ audio: speechAudio, onStatus: status => speechStatuses.push(status), onTurn() {},
    open: async () => ({ onFrame(fn) { speechDeliver = fn; }, onClose() {}, start() {}, close() {}, send(frame) { speechSent.push(frame); return true; } }),
    webrtc: options => webRtcPeer({ ...options, platform: { createPeer: () => speechPeer,
      getUserMedia: async () => ({ getAudioTracks: () => [speechTrack], getTracks: () => [speechTrack] }) as unknown as MediaStream } }),
  });
  t.after(() => speechClient.stop());
  await waitFor(() => !!speechDeliver); speechDeliver({ type: 'realtime.webrtc.start', dataChannelLabel: 'events' });
  await waitFor(() => speechSent.some(frame => frame.type === 'realtime.webrtc.offer'));
  speechPeer.connectionState = 'connected'; speechPeer.onconnectionstatechange();
  speechClient.setMuted(true);
  speechDeliver({ type: 'realtime.state', state: 'thinking' }); speechDeliver({ type: 'realtime.state', state: 'connected' });
  assert.equal(speechStatuses.at(-1), 'connected');
  blocked = true; speechClient.speak('Avery has finished.'); assert.ok(afterDrain);
  assert.ok(!speechSent.some(frame => frame.type === 'realtime.say'));
  speechDeliver({ type: 'realtime.audio.clear' });
  assert.ok(speechSent.some(frame => frame.type === 'realtime.say' && frame.text === 'Avery has finished.'));
  speechClient.stop(); await waitFor(() => speechEvents.includes('release'));
  assert.equal(speechEvents.filter(value => value === 'acquire').length, 1);
  assert.equal(speechEvents.filter(value => value === 'release').length, 1);
  assert.equal(speechEvents.filter(value => value === 'track-stop').length, 1);
  const encodingControl = () => {
    let parameters = { encodings: [{ active: false }] };
    return {
      getParameters: () => structuredClone(parameters),
      async setParameters(value: typeof parameters) { parameters = structuredClone(value); },
    };
  };
  const events: string[] = [], sent: RealtimeClientFrame[] = [], tracks: MediaStreamTrack[] = [];
  let deliver!: (frame: RealtimeHostFrame) => void, offers = 0, descriptions = 0;
  const replacements: (MediaStreamTrack | null)[] = [], active: boolean[] = [];
  const control = encodingControl();
  const sender = { ...control, track: null as MediaStreamTrack | null,
    async setParameters(value: ReturnType<typeof control.getParameters>) {
      active.push(value.encodings[0].active);
      if (value.encodings[0].active) assert.ok(this.track, 'Sending starts only after a track is attached');
      await control.setParameters(value);
    },
    async replaceTrack(track: MediaStreamTrack | null) {
      if (!track) assert.equal(this.getParameters().encodings[0].active, false);
      replacements.push(track); this.track = track;
    } };
  const peer: any = { connectionState: 'connecting', iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' },
    createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }),
    addTrack() { assert.fail('Lazy capture must negotiate without addTrack'); },
    addTransceiver(kind: string, options: object) { assert.equal(kind, 'audio'); assert.deepEqual(options, { direction: 'sendrecv', sendEncodings: [{ active: false }] }); assert.equal(sender.track, null); events.push('transceiver'); return { sender }; },
    createOffer: async () => { assert.equal(sender.getParameters().encodings[0].active, false); offers++; return { type: 'offer', sdp: 'v=0\r\n' }; },
    setLocalDescription: async () => { descriptions++; }, setRemoteDescription: async () => { assert.equal(sender.getParameters().encodings[0].active, false); }, close() { events.push('peer-close'); } };
  const client = realtimeClient({ capture: 'lazy', audio: audioPorts(events), onStatus() {}, onTurn() {},
    open: async () => ({ onFrame(fn) { deliver = fn; }, onClose() {}, start() {}, close() {}, send(frame) { sent.push(frame); return true; } }),
    webrtc: options => webRtcPeer({ ...options, platform: { createPeer: () => peer, getUserMedia: async () => {
      events.push('media'); const track = { kind: 'audio', enabled: true, stop() { events.push('track-stop'); } } as unknown as MediaStreamTrack;
      tracks.push(track); return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    } } }),
  });
  t.after(() => client.stop());
  await waitFor(() => !!deliver); deliver({ type: 'realtime.webrtc.start', dataChannelLabel: 'events' });
  await waitFor(() => sent.some(frame => frame.type === 'realtime.webrtc.offer'));
  // Preconnect negotiates an inactive send stream with no microphone lease or capture.
  assert.deepEqual(events, ['route', 'transceiver']); assert.equal(sender.track, null);
  deliver({ type: 'realtime.webrtc.answer', sdp: 'v=0\r\n' });
  for (let cycle = 0; cycle < 2; cycle++) {
    client.setMuted(true);
    await Promise.all([client.attachMic(), client.attachMic()]);
    assert.equal(tracks.length, cycle + 1); assert.equal(sender.track, tracks[cycle]); assert.equal(tracks[cycle].enabled, false);
    client.setMuted(false); assert.equal(tracks[cycle].enabled, true);
    await Promise.all([client.releaseMic(), client.releaseMic()]);
    assert.equal(sender.track, null);
    assert.equal(sender.getParameters().encodings[0].active, false);
    assert.equal(events.filter(value => value === 'release').length, cycle + 1);
    assert.equal(events.filter(value => value === 'track-stop').length, cycle + 1);
  }
  await client.attachMic(); client.stop();
  await waitFor(() => events.includes('unroute'));
  assert.equal(events.filter(value => value === 'acquire').length, 3);
  assert.equal(events.filter(value => value === 'release').length, 3);
  assert.equal(events.filter(value => value === 'track-stop').length, 3);
  assert.deepEqual(replacements, [tracks[0], null, tracks[1], null, tracks[2]]);
  assert.deepEqual(active, [false, true, false, true, false, true]);
  assert.equal(offers, 1); assert.equal(descriptions, 1);
  assert.equal(sent.filter(frame => frame.type === 'realtime.webrtc.offer').length, 1);

  // A rejected encoding change closes the device rather than leaving it recording silently.
  for (const failure of ['setup', 'attach', 'release'] as const) {
    const failureEvents: string[] = [];
    let encodingActive = failure === 'setup', reject = false;
    const track = { enabled: true, stop() { failureEvents.push('track-stop'); } } as unknown as MediaStreamTrack;
    const failureSender = { getParameters: () => ({ encodings: [{ active: encodingActive }] }),
      async setParameters(parameters: { encodings: { active: boolean }[] }) { if (failure !== 'setup' && !reject) encodingActive = parameters.encodings[0].active; }, async replaceTrack() {} };
    const failurePeer = { iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' },
      createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }),
      addTransceiver: () => ({ sender: failureSender }), createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }),
      setLocalDescription: async () => {}, close() { failureEvents.push('peer-close'); } } as unknown as RTCPeerConnection;
    const create = () => webRtcPeer({ capture: 'lazy', label: 'events', audio: audioPorts(failureEvents),
      platform: { createPeer: () => failurePeer, getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream },
      onOffer() {}, onData() {}, onRemoteAudio() {}, onConnectionState() {}, onInterruption() {}, onError() {} });
    if (failure === 'setup') { await assert.rejects(create(), /capture control failed/); assert.ok(!failureEvents.includes('acquire')); }
    else {
      const handle = await create();
      if (failure === 'attach') { reject = true; await assert.rejects(handle.attachMic(), /capture control failed/); assert.equal(encodingActive, false); assert.ok(!failureEvents.includes('peer-close')); reject = false; await handle.attachMic(); }
      else await handle.attachMic();
      if (failure === 'release') { reject = true; await assert.rejects(handle.releaseMic(), /capture control failed/); assert.ok(failureEvents.includes('peer-close'), 'Close the device if encoding suppression is rejected'); }
      else await handle.releaseMic();
      handle.stop();
      assert.equal(failureEvents.filter(value => value === 'release').length, failure === 'attach' ? 2 : 1);
    }
    assert.equal(failureEvents.filter(value => value === 'peer-close').length, 1);
  }

  // A carrier drop with WebRTC waits for the prior route to release, then negotiates a fresh peer.
  const reconnectEvents: string[] = [], frames: ((frame: RealtimeHostFrame) => void)[] = [], closes: (() => void)[] = [];
  let opens = 0, stoppedTracks = 0, releaseRoute!: () => void;
  const reconnectAudio = audioPorts(reconnectEvents);
  reconnectAudio.unroute = async () => { reconnectEvents.push('unroute'); if (opens === 1) await new Promise<void>(resolve => { releaseRoute = resolve; }); };
  const reconnecting = realtimeClient({ audio: reconnectAudio, onStatus() {}, onTurn() {},
    open: async () => { opens++; return { send: () => true, onFrame(fn) { frames.push(fn); }, onClose(fn) { closes.push(() => fn('Connection lost')); }, start() {}, close() {} }; },
    webrtc: options => webRtcPeer({ ...options, platform: {
      createPeer: () => ({ connectionState: 'connecting', iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' }, createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, close() {}, send() {} }), addTrack() {}, createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {} }) as unknown as RTCPeerConnection,
      getUserMedia: async () => { reconnectEvents.push('media'); const track = { kind: 'audio', enabled: true, stop() { stoppedTracks++; } }; return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream; },
    } }),
  });
  t.after(() => { releaseRoute?.(); reconnecting.stop(); });
  await waitFor(() => frames.length === 1); frames[0]({ type: 'realtime.webrtc.start', dataChannelLabel: 'oai-events' });
  await waitFor(() => reconnectEvents.includes('media')); closes[0]();
  await waitFor(() => !!releaseRoute); await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(opens, 1); assert.equal(stoppedTracks, 1);
  releaseRoute(); await waitFor(() => opens === 2);
  frames[1]({ type: 'realtime.webrtc.start', dataChannelLabel: 'oai-events' });
  await waitFor(() => reconnectEvents.filter(event => event === 'media').length === 2);
  reconnecting.stop(); await waitFor(() => reconnectEvents.filter(event => event === 'unroute').length === 2);
  assert.equal(reconnectEvents.filter(event => event === 'release').length, 2); assert.equal(stoppedTracks, 2);
});

test('advisory auth stays read-only and bounded, and the portable entry runs where there is no Node', async t => {
  const messages = {
    'credential-permissions': 'Your saved sign-in must be readable only by you.',
    'login-expired': 'Your saved sign-in has expired. Sign in again in settings.',
    missing: 'No saved sign-in was found. Sign in in settings.',
    unknown: 'Your saved sign-in could not be checked.',
  } as const;
  for (const reason of ['credential-permissions', 'login-expired', 'missing', 'unknown'] as const) {
    const state = reason === 'unknown' ? 'unknown' : 'signed-out';
    let observed: unknown;
    const check = realtimeAuthCheck({ peek: async () => ({ state, reason }), onResult: value => { observed = value; } });
    assert.equal(await check.result, state);
    assert.deepEqual(await check.details, { state, reason, message: messages[reason] });
    assert.deepEqual(observed, await check.details);
  }
  for (const state of ['ready', 'signed-out', 'unknown'] as const) assert.deepEqual(await realtimeAuthCheck({ peek: async () => ({ state }) }).details, { state });
  for (const value of [true, false]) assert.deepEqual(await realtimeAuthCheck({ peek: async () => value }).details, { state: value ? 'ready' : 'signed-out' });
  for (const [code, reason] of [['ENOENT', 'missing'], ['EACCES', 'credential-permissions'], ['EPERM', 'credential-permissions'], ['TOKEN_EXPIRED', 'login-expired']] as const) {
    const error = Object.assign(new Error('private-token /private/sign-in'), { code });
    assert.deepEqual(await realtimeAuthCheck({ peek: async () => { throw error; } }).details, { state: 'signed-out', reason, message: messages[reason] });
  }
  for (const [message, reason] of [['Credential file must be owner-only: /private/token', 'credential-permissions'], ['Login expired: private-token', 'login-expired']] as const) {
    assert.equal((await realtimeAuthCheck({ peek: async () => { throw new Error(message); } }).details).reason, reason);
  }
  // Unrecognized errors, a bare reason and an app-defined reason all stay within the state contract.
  assert.deepEqual(await realtimeAuthCheck({ peek: async () => { throw Object.assign(new Error('private-token'), { reason: 'private-token' }); } }).details, { state: 'unknown', reason: 'unknown', message: messages.unknown });
  assert.equal((await realtimeAuthCheck({ peek: async () => ({ state: 'unknown', reason: 'app-policy' }) }).details).reason, 'app-policy');
  // A throwing observer or a closed check never fails a caller; a closed check never starts its peek.
  assert.equal(await realtimeAuthCheck({ peek: async () => true, onResult: () => { throw new Error('observer'); } }).result, 'ready');
  assert.equal(await realtimeAuthCheck({ peek: async () => true, onStatus: () => { throw new Error('observer'); } }).result, 'ready');
  const closed = realtimeAuthCheck({ peek: async () => { assert.fail('Closed checks never start'); } }); closed.close();
  assert.equal(await closed.result, 'unknown');

  // The check starts independently, cannot gate startup and cannot close the session; a late peek is aborted.
  const frames: RealtimeHostFrame[] = [], statuses: string[] = [], diagnostics: unknown[] = [];
  let peekSignal!: AbortSignal, complete!: (ready: boolean) => void, accesses = 0;
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => { accesses++; return { access: 'fake-token', accountId: 'fake-account' }; } },
    authCheck: { timeoutMs: 100, peek: signal => { peekSignal = signal; return new Promise(resolve => { complete = resolve; }); }, onStatus: status => statuses.push(status), onResult: value => diagnostics.push(value) },
    bridge: toolBridge({ tools: [], handlers: {}, emit: () => {}, failure: () => 'Failed' }), emit: frame => frames.push(frame) });
  t.after(() => engine.close());
  await engine.ready;
  assert.equal(accesses, 1); assert.deepEqual(statuses, []);
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.start'));
  await waitFor(() => statuses.length === 1);
  assert.deepEqual(statuses, ['unknown']); assert.ok(peekSignal.aborted);
  assert.deepEqual(diagnostics, [{ state: 'unknown', reason: 'unknown', message: messages.unknown }]);
  complete(false); await Promise.resolve(); assert.deepEqual(statuses, ['unknown']);
  assert.ok(!frames.some(frame => frame.type === 'realtime.closed'));

  // The published portable entry bundles for a browser / React Native phone with no Node and runs there.
  const bundle = await build({
    stdin: { contents: `import { providers, realtimePcm16ByteLength, parseRealtimeClientFrame } from '@byokit/realtime';
      globalThis.result = { plan: providers.find(p => p.id === 'chatgpt').planSignIn, bytes: realtimePcm16ByteLength('AAA='), reject: (() => { try { parseRealtimeClientFrame({ type: 'realtime.webrtc.offer', sdp: 'v=0' + 'x'.repeat(128 * 1024) }); return false; } catch { return true; } })() };`,
      resolveDir: import.meta.dirname, sourcefile: 'phone-realtime.ts' },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, metafile: true, logLevel: 'silent',
  });
  assert.ok(Object.keys(bundle.metafile!.inputs).every(path => !path.includes('/node.') && !/^ws$/.test(path) && !path.includes('node:')));
  const sandbox: any = {};
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  assert.deepEqual({ ...sandbox.result }, { plan: true, bytes: 2, reject: true });
  assert.throws(() => realtimePcm16ByteLength('AA=='));
  assert.throws(() => parseRealtimeHostFrame({ type: 'realtime.usage', usage: { basis: 'tokens', seconds: 1, inputTokens: -1 } }));
  const native = await build({
    stdin: { contents: `import { webRtcPeer } from '@byokit/realtime/webrtc'; globalThis.peer = webRtcPeer;`, resolveDir: import.meta.dirname, sourcefile: 'phone-webrtc.ts' },
    bundle: true, platform: 'neutral', conditions: ['react-native'], external: ['react-native-webrtc'], write: false,
  });
  assert.ok(!native.outputFiles[0].text.includes('node:'));
  assert.match(native.outputFiles[0].text, /import\("react-native-webrtc"\)/);
});
