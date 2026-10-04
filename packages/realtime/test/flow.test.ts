import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { realtimeEngine, toolBridge, delegationHandler } from '../src/node.ts';
import { appBridge } from '../src/tools.ts';
import { realtimeClient, realtimeAuthCheck, parseRealtimeClientFrame, parseRealtimeHostFrame, realtimePcm16ByteLength, providers, type AudioPorts, type RealtimeHostFrame, type RealtimeClientFrame, type RealtimeStream } from '../src/index.ts';
import { webRtcPeer } from '../src/webrtc.ts';
import { reactNativeWebRtcPeer } from '../src/rn-webrtc.ts';
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
test('ChatGPT structured delegation preserves named targets, dedupes calls, and pushes lifecycle context', async t => {
  const frames: RealtimeHostFrame[] = [], receipts: string[] = [];
  let plans = 0;
  const actions = [{ name: 'message', description: 'Send an authorized message to a named target', parameters: { type: 'object', properties: { agent: { type: 'string' }, text: { type: 'string' } }, required: ['agent', 'text'] } }];
  const actionBridge = toolBridge({ tools: actions, handlers: { message: async args => {
    assert.deepEqual(args, { agent: 'Avery', text: 'Please report progress' }); receipts.push('queued'); return 'Queued for Avery';
  } }, emit: frame => frames.push(frame), failure: () => 'Failed' });
  const delegate = delegationHandler({ bridge: actionBridge, plan: async request => { plans++; return `Clarify: ${request}`; } });
  const delegateTools = [{ name: 'delegate', description: 'Delegate a request', parameters: { type: 'object' } }];
  const bridge = toolBridge({ tools: delegateTools, handlers: { delegate }, emit: frame => frames.push(frame), failure: () => 'Failed' });
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'fake-token', accountId: 'fake-account' }) }, tools: delegateTools, bridge, emit: frame => frames.push(frame) });
  t.after(() => { engine.close(); actionBridge.close(); });
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.start'));
  const request = JSON.stringify({ name: 'message', arguments: { agent: 'Avery', text: 'Please report progress' } });
  for (const id of ['s1', 's1', 's2']) engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id, type: 'delegation', target: 'client', user_bidi_turn_id: 'same-turn', content: [{ type: 'input_text', text: request }] } }) });
  await waitFor(() => frames.filter(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append').length === 2);
  assert.deepEqual(receipts, ['queued']); assert.equal(plans, 0);
  engine.receive({ type: 'realtime.say', text: 'Host confirms Avery has finished the task.' });
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'session.context.append'));
  assert.ok(frames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).content?.[0]?.text === 'Host confirms Avery has finished the task.'));
  const context = { id: 'direct', signal: new AbortController().signal };
  for (const invalid of ['{"name":', '{"name":"shell","arguments":{}}', '{"name":"message","arguments":null}', '{"name":"delegate","arguments":{}}']) {
    assert.match(await delegate({ request: invalid }, context), /invalid/);
  }
  assert.equal(plans, 0); assert.deepEqual(receipts, ['queued']);
  assert.equal(await delegate({ request: 'Which agent should receive this?' }, context), 'Clarify: Which agent should receive this?');
  assert.equal(plans, 1);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(delegate({ request }, { id: 'cancel', signal: cancel.signal }));
  assert.deepEqual(receipts, ['queued']);
});
test('advisory auth reports safe reasons and keeps legacy status results', async () => {
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
  for (const state of ['ready', 'signed-out', 'unknown'] as const) {
    assert.deepEqual(await realtimeAuthCheck({ peek: async () => ({ state }) }).details, { state });
  }
  for (const value of [true, false]) {
    assert.deepEqual(await realtimeAuthCheck({ peek: async () => value }).details, { state: value ? 'ready' : 'signed-out' });
  }
  for (const [code, reason] of [['ENOENT', 'missing'], ['EACCES', 'credential-permissions'], ['EPERM', 'credential-permissions'], ['TOKEN_EXPIRED', 'login-expired']] as const) {
    const error = Object.assign(new Error('private-token /private/sign-in'), { code });
    const check = realtimeAuthCheck({ peek: async () => { throw error; } });
    assert.deepEqual(await check.details, { state: 'signed-out', reason, message: messages[reason] });
  }
  for (const [message, reason] of [['Credential file must be owner-only: /private/token', 'credential-permissions'], ['Login expired: private-token', 'login-expired']] as const) {
    assert.equal((await realtimeAuthCheck({ peek: async () => { throw new Error(message); } }).details).reason, reason);
  }
  assert.deepEqual(await realtimeAuthCheck({ peek: async () => { throw Object.assign(new Error('private-token'), { reason: 'private-token' }); } }).details,
    { state: 'unknown', reason: 'unknown', message: messages.unknown });
  assert.equal((await realtimeAuthCheck({ peek: async () => ({ state: 'unknown', reason: 'app-policy' }) }).details).reason, 'app-policy');
  assert.equal(await realtimeAuthCheck({ peek: async () => true, onResult: () => { throw new Error('observer'); } }).result, 'ready');
});
test('advisory auth is bounded, read-only and cannot gate or close a session', async t => {
  for (const [value, status] of [[true, 'ready'], [false, 'signed-out']] as const) {
    assert.equal(await realtimeAuthCheck({ peek: async () => value }).result, status);
  }
  assert.equal(await realtimeAuthCheck({ peek: async () => { throw new Error('unavailable'); } }).result, 'unknown');
  assert.equal(await realtimeAuthCheck({ peek: async () => true, onStatus: () => { throw new Error('observer'); } }).result, 'ready');
  const closed = realtimeAuthCheck({ peek: async () => { assert.fail('Closed checks never start'); } }); closed.close();
  assert.equal(await closed.result, 'unknown');
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
  assert.deepEqual(diagnostics, [{ state: 'unknown', reason: 'unknown', message: 'Your saved sign-in could not be checked.' }]);
  complete(false); await Promise.resolve(); assert.deepEqual(statuses, ['unknown']);
  assert.ok(!frames.some(frame => frame.type === 'realtime.closed')); engine.close();
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
test('semantic app tool replies cross a fake client and provider child and close cancels pending replies', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const replies: string[] = [];
  server.on('connection', socket => socket.on('message', raw => {
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
  let engine!: ReturnType<typeof realtimeEngine>, deliver!: (frame: RealtimeHostFrame) => void;
  const app = appBridge(frame => deliver(frame));
  const appTools = [{ name: 'navigate', description: 'Open a semantic destination', parameters: { type: 'object' } }];
  const bridge = toolBridge({ tools: appTools, app, handlers: { navigate: (args, ctx) => app.run('navigate', String(args.target), ctx.signal) }, emit: frame => deliver(frame), failure: () => 'Failed' });
  const client = realtimeClient({ audio: audioPorts([]), onStatus() {}, onTurn() {},
    onAppRequest: async (action, target) => { assert.equal(action, 'navigate'); assert.equal(target, 'Home'); return { ok: true, text: 'Opened Home' }; },
    open: async () => ({ onFrame(fn) { deliver = fn; }, onClose() {}, send(frame) { return engine.receive(frame); },
      start() { engine = realtimeEngine({ engine: 'openai', auth: { kind: 'key', key: 'fake-secret' }, tools: appTools, bridge,
        endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, emit: frame => deliver(frame) }); }, close() { engine?.close(); } }),
  });
  t.after(() => { client.stop(); engine?.close(); });
  await waitFor(() => replies.length === 1); assert.deepEqual(replies, ['Opened Home']);
  const pending = app.run('view'); engine.close();
  assert.equal(await pending, 'The app request was cancelled.');
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
function encodingControl() {
  let parameters = { encodings: [{ active: false }] };
  return {
    getParameters: () => structuredClone(parameters),
    async setParameters(value: typeof parameters) { parameters = structuredClone(value); },
  };
}
test('lazy browser and RN WebRTC negotiate inactive senders, attach/release repeatedly and close attached', async t => {
  const NativeController = AbortController;
  t.mock.method(globalThis, 'AbortController', function () {
    const controller = new NativeController();
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    return controller;
  });
  for (const factory of [webRtcPeer, reactNativeWebRtcPeer]) {
    const events: string[] = [], sent: RealtimeClientFrame[] = [], tracks: MediaStreamTrack[] = [];
    let deliver!: (frame: RealtimeHostFrame) => void, offers = 0, descriptions = 0;
    const replacements: (MediaStreamTrack | null)[] = [];
    const active: boolean[] = [];
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
      webrtc: options => factory({ ...options, platform: { createPeer: () => peer, getUserMedia: async () => {
        events.push('media'); const track = { kind: 'audio', enabled: true, stop() { events.push('track-stop'); } } as unknown as MediaStreamTrack;
        tracks.push(track); return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
      } } }),
    });
    t.after(() => client.stop());
    await waitFor(() => !!deliver); deliver({ type: 'realtime.webrtc.start', dataChannelLabel: 'events' });
    await waitFor(() => sent.some(frame => frame.type === 'realtime.webrtc.offer'));
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
    await assert.rejects(client.attachMic(), /unavailable/);
  }
});
test('lazy microphone cancellation and failures release pending capture and permit another attach', async () => {
  for (const pending of ['acquire', 'media', 'replace'] as const) {
    for (const close of [false, true]) {
      const events: string[] = []; let resume!: () => void;
      const audio = audioPorts(events);
      if (pending === 'acquire') audio.microphone.acquire = async () => { events.push('acquire'); await new Promise<void>(resolve => { resume = resolve; }); };
      const track = { enabled: true, stop() { events.push('track-stop'); } } as unknown as MediaStreamTrack;
      const sender = { ...encodingControl(), async replaceTrack(input: MediaStreamTrack | null) { if (input && pending === 'replace') await new Promise<void>(resolve => { resume = resolve; }); } };
      const peer = { iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' },
        createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }), addTransceiver: () => ({ sender }),
        createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, close() {} } as unknown as RTCPeerConnection;
      const handle = await webRtcPeer({ capture: 'lazy', label: 'events', audio, platform: { createPeer: () => peer,
        getUserMedia: async () => { events.push('media'); if (pending === 'media') await new Promise<void>(resolve => { resume = resolve; }); return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream; } },
        onOffer() {}, onData() {}, onRemoteAudio() {}, onConnectionState() {}, onInterruption() {}, onError(error) { throw error; } });
      const attaching = handle.attachMic(); await waitFor(() => !!resume);
      if (close) handle.stop();
      const releasing = handle.releaseMic(); resume(); await attaching; await releasing;
      assert.equal(events.filter(value => value === 'release').length, 1);
      assert.equal(events.filter(value => value === 'track-stop').length, pending === 'acquire' ? 0 : 1);
      handle.stop();
    }
  }
  const events: string[] = []; let fail = true;
  const track = { enabled: true, stop() { events.push('track-stop'); } } as unknown as MediaStreamTrack;
  const peer = { iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' },
    createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }),
    addTransceiver: () => ({ sender: { ...encodingControl(), async replaceTrack(input: MediaStreamTrack | null) { if (fail && input) throw new Error('Capture failed'); } } }),
    createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, close() {} } as unknown as RTCPeerConnection;
  const handle = await webRtcPeer({ capture: 'lazy', label: 'events', audio: audioPorts(events), platform: { createPeer: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream },
    onOffer() {}, onData() {}, onRemoteAudio() {}, onConnectionState() {}, onInterruption() {}, onError(error) { throw error; } });
  await assert.rejects(handle.attachMic(), /Capture failed/);
  assert.equal(events.filter(value => value === 'release').length, 1);
  fail = false; await handle.attachMic(); await handle.releaseMic(); handle.stop();
  assert.equal(events.filter(value => value === 'release').length, 2);
});
test('lazy encoding control rejects silent native failures and closes if recording cannot be disabled', async () => {
  for (const failure of ['setup', 'attach', 'release'] as const) {
    const events: string[] = [];
    let active = failure === 'setup', reject = false;
    const track = { enabled: true, stop() { events.push('track-stop'); } } as unknown as MediaStreamTrack;
    const sender = { getParameters: () => ({ encodings: [{ active }] }),
      async setParameters(parameters: { encodings: { active: boolean }[] }) {
        if (failure !== 'setup' && !reject) active = parameters.encodings[0].active;
      }, async replaceTrack() {} };
    const peer = { iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' },
      createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }),
      addTransceiver: () => ({ sender }), createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }),
      setLocalDescription: async () => {}, close() { events.push('peer-close'); } } as unknown as RTCPeerConnection;
    const create = () => webRtcPeer({ capture: 'lazy', label: 'events', audio: audioPorts(events),
      platform: { createPeer: () => peer, getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream },
      onOffer() {}, onData() {}, onRemoteAudio() {}, onConnectionState() {}, onInterruption() {}, onError() {} });
    if (failure === 'setup') {
      await assert.rejects(create(), /capture control failed/);
      assert.ok(!events.includes('acquire'));
    } else {
      const handle = await create();
      if (failure === 'attach') {
        reject = true; await assert.rejects(handle.attachMic(), /capture control failed/);
        assert.equal(active, false); assert.ok(!events.includes('peer-close'));
        reject = false; await handle.attachMic();
      } else await handle.attachMic();
      if (failure === 'release') {
        reject = true; await assert.rejects(handle.releaseMic(), /capture control failed/);
        assert.ok(events.includes('peer-close'), 'Close the device if encoding suppression is rejected');
      } else await handle.releaseMic();
      handle.stop();
      assert.equal(events.filter(value => value === 'release').length, failure === 'attach' ? 2 : 1);
    }
    assert.equal(events.filter(value => value === 'peer-close').length, 1);
  }
});
test('RN-shaped WebRTC starts without throwIfAborted, handles empty playback and flushes a muted report after clear', async t => {
  const NativeController = AbortController;
  t.mock.method(globalThis, 'AbortController', function () {
    const controller = new NativeController();
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    return controller;
  });
  const events: string[] = [], sent: RealtimeClientFrame[] = [], statuses: string[] = [];
  let deliver!: (frame: RealtimeHostFrame) => void, blocked = false, afterDrain: (() => void) | undefined;
  const audio = audioPorts(events);
  audio.player.finish = () => false;
  audio.player.afterDrain = (_kind, fn) => { if (!blocked) return false; afterDrain = fn; return true; };
  audio.player.clear = () => { blocked = false; afterDrain = undefined; };
  const track = { kind: 'audio', enabled: true, stop() { events.push('track-stop'); } };
  const peer: any = { connectionState: 'connecting', iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' },
    createDataChannel: () => ({ readyState: 'connecting', bufferedAmount: 0, send() {}, close() {} }), addTrack() {},
    createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {} };
  const client = realtimeClient({ audio, onStatus: status => statuses.push(status), onTurn() {},
    open: async () => ({ onFrame(fn) { deliver = fn; }, onClose() {}, start() {}, close() {}, send(frame) { sent.push(frame); return true; } }),
    webrtc: options => webRtcPeer({ ...options, platform: { createPeer: () => peer,
      getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream } }),
  });
  t.after(() => client.stop());
  await waitFor(() => !!deliver); deliver({ type: 'realtime.webrtc.start', dataChannelLabel: 'events' });
  await waitFor(() => sent.some(frame => frame.type === 'realtime.webrtc.offer'));
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  client.setMuted(true);
  deliver({ type: 'realtime.state', state: 'thinking' }); deliver({ type: 'realtime.state', state: 'connected' });
  assert.equal(statuses.at(-1), 'connected');
  blocked = true; client.speak('Avery has finished.'); assert.ok(afterDrain);
  assert.ok(!sent.some(frame => frame.type === 'realtime.say'));
  deliver({ type: 'realtime.audio.clear' });
  assert.ok(sent.some(frame => frame.type === 'realtime.say' && frame.text === 'Avery has finished.'));
  client.stop(); await waitFor(() => events.includes('release'));
  assert.equal(events.filter(value => value === 'acquire').length, 1);
  assert.equal(events.filter(value => value === 'release').length, 1);
  assert.equal(events.filter(value => value === 'track-stop').length, 1);
});
test('opt-in carrier reconnect retains ready PCM capture and playback tail, then releases exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: string[] = [], frames: ((frame: RealtimeHostFrame) => void)[] = [], closes: (() => void)[] = [], sent: RealtimeClientFrame[][] = [];
  let capture!: (data: string) => void;
  const audio = audioPorts(events);
  audio.capture = async (_rate, fn) => { events.push('capture'); capture = fn; return { pending: [], release: async () => { events.push('capture-release'); } }; };
  const client = realtimeClient({ audio, preserveMediaOnReconnect: true, onStatus() {}, onTurn() {}, open: async () => {
    const output: RealtimeClientFrame[] = []; sent.push(output);
    return { onFrame(fn) { frames.push(fn); }, onClose(fn) { closes.push(() => fn('carrier lost')); }, start() {}, close() {}, send(frame) { output.push(frame); return true; } };
  } });
  t.after(() => client.stop());
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  await settle(); frames[0]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 }); await settle();
  capture('AAA='); closes[0](); capture('AgACAA==');
  assert.ok(!events.includes('clear')); assert.ok(!events.includes('release')); assert.ok(!events.includes('capture-release'));
  await settle(); t.mock.timers.tick(500); await settle();
  frames[1]({ type: 'realtime.ready', inputRate: 24000, outputRate: 24000 }); await settle();
  capture('AQABAA==');
  assert.equal(events.filter(value => value === 'acquire').length, 1); assert.equal(events.filter(value => value === 'capture').length, 1);
  assert.deepEqual(sent[1], [{ type: 'realtime.audio', data: 'AQABAA==' }]);
  closes[1](); client.stop(); await settle();
  assert.equal(events.filter(value => value === 'release').length, 1); assert.equal(events.filter(value => value === 'capture-release').length, 1);
  assert.equal(events.filter(value => value === 'unroute').length, 1);
  t.mock.timers.tick(2000); await settle(); assert.equal(sent.length, 2);
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
test('ChatGPT keeps delegation on a new user turn; explicit interrupt cancels and rotates the call', async t => {
  const frames: RealtimeHostFrame[] = []; let entered = false, aborted = false;
  const delegateTools = [{ name: 'delegate', description: 'Handle a request', parameters: { type: 'object' } }];
  const bridge = toolBridge({ tools: delegateTools, handlers: { delegate: async (_args, context) => { entered = true; context.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }, emit: frame => frames.push(frame), failure: () => 'Cancelled' });
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'test-token', accountId: 'account1' }) }, tools: delegateTools, bridge, emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.start'));
  engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id: 'old', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Demo request' }] } }) });
  await waitFor(() => entered);
  engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'turn.done', turn: { role: 'user', transcript: 'Stop please' } }) });
  await waitFor(() => frames.some(frame => frame.type === 'realtime.audio.clear'));
  assert.equal(aborted, false);
  engine.receive({ type: 'realtime.control', action: 'interrupt' });
  await waitFor(() => frames.some(frame => frame.type === 'realtime.closed'));
  assert.equal(aborted, true);
  assert.ok(frames.some(frame => frame.type === 'realtime.closed' && frame.retryable === true));
  assert.ok(!frames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append'));
});
test('ChatGPT long delegation survives user turns and retransmission; empty transcripts do nothing', async t => {
  const frames: RealtimeHostFrame[] = []; let calls = 0, aborted = false, resolve!: (text: string) => void;
  const delegateTools = [{ name: 'delegate', description: 'Delegate', parameters: { type: 'object' } }];
  const bridge = toolBridge({ tools: delegateTools, timeoutFor: () => 340000, handlers: { delegate: async (_args, ctx) => {
    calls++; ctx.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(done => { resolve = done; });
  } }, emit: frame => frames.push(frame), failure: () => 'The action is unconfirmed; do not repeat it.' });
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'fake-token', accountId: 'fake-account' }) }, tools: delegateTools, bridge, emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await engine.ready;
  const event = (value: unknown) => engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify(value) });
  const delegation = (id: string) => event({ type: 'delegation.created', item: { id, type: 'delegation', target: 'client', user_bidi_turn_id: 'original', content: [{ type: 'input_text', text: 'Watch Avery' }] } });
  delegation('long-1'); await waitFor(() => calls === 1);
  event({ type: 'turn.done', turn: { role: 'user', transcript: '' } });
  event({ type: 'turn.done', turn: { role: 'assistant', transcript: ' \n\t ' } });
  event({ type: 'turn.done', turn: { role: 'user', transcript: 'Keep watching' } });
  delegation('long-2');
  await waitFor(() => frames.some(frame => frame.type === 'realtime.transcript' && frame.text === 'Keep watching'));
  assert.equal(aborted, false); assert.equal(calls, 1);
  assert.equal(frames.filter(frame => frame.type === 'realtime.audio.clear').length, 1);
  assert.deepEqual(frames.filter(frame => frame.type === 'realtime.transcript').map(frame => frame.text), ['Keep watching']);
  resolve('Avery is done; this is the confirmed receipt.');
  await waitFor(() => frames.filter(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append').length === 2);
  assert.equal(calls, 1); assert.equal(aborted, false);
});
test('host tool watchdog and failure wording reach the child without a second child budget', async t => {
  const frames: RealtimeHostFrame[] = []; let timedOut = false;
  const delegateTools = [{ name: 'delegate', description: 'Delegate', parameters: { type: 'object' } }];
  const bridge = toolBridge({ tools: delegateTools, timeoutFor: name => { assert.equal(name, 'delegate'); return 20; },
    handlers: { delegate: async () => new Promise(() => {}) }, emit: frame => frames.push(frame),
    failure: (_name, _error, timeout) => { timedOut = timeout; return 'The action is unconfirmed; do not repeat it.'; } });
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'fake-token', accountId: 'fake-account' }) }, tools: delegateTools, bridge, emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await engine.ready;
  engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'delegation.created', item: { id: 'timeout', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Perform the action' }] } }) });
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).type === 'delegation.context.append'));
  assert.equal(timedOut, true);
  assert.ok(frames.some(frame => frame.type === 'realtime.webrtc.data' && JSON.parse(frame.data).content?.[0]?.text === 'The action is unconfirmed; do not repeat it.'));
});
for (const provider of ['chatgpt', 'openai', 'gemini', 'xai'] as const) test(`${provider}: app hangup policy waits for the agent's farewell transcript`, async t => {
  const frames: RealtimeHostFrame[] = []; let socket: WebSocket | undefined;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  server.on('connection', ws => { socket = ws; ws.once('message', () => ws.send(JSON.stringify(provider === 'gemini' ? { setupComplete: {} } : { type: 'session.updated' }))); });
  const engine = realtimeEngine({ engine: provider,
    auth: provider === 'chatgpt' ? { kind: 'plan', access: async () => ({ access: 'fake-token', accountId: 'fake-account' }) } : { kind: 'key', key: 'fake-key' },
    ...(provider === 'chatgpt' ? {} : { endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    hangup: text => text === 'Goodbye', bridge: toolBridge({ tools: [], handlers: {}, emit: frame => frames.push(frame), failure: () => 'Failed' }), emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await engine.ready;
  if (provider !== 'chatgpt') await waitFor(() => frames.some(frame => frame.type === 'realtime.ready'));
  const turn = (role: 'user' | 'agent', text: string) => {
    if (provider === 'chatgpt') engine.receive({ type: 'realtime.webrtc.data', data: JSON.stringify({ type: 'turn.done', turn: { role: role === 'agent' ? 'assistant' : 'user', transcript: text } }) });
    else if (provider === 'gemini') socket!.send(JSON.stringify({ serverContent: { [role === 'user' ? 'inputTranscription' : 'outputTranscription']: { text }, turnComplete: true } }));
    else {
      if (role === 'agent') socket!.send(JSON.stringify({ type: 'response.created', response: { id: 'farewell' } }));
      socket!.send(JSON.stringify({ type: role === 'user' ? 'conversation.item.input_audio_transcription.completed' : 'response.output_audio_transcript.done', response_id: 'farewell', transcript: text }));
    }
  };
  turn('user', 'Goodbye'); await waitFor(() => frames.some(frame => frame.type === 'realtime.transcript' && frame.role === 'user'));
  assert.ok(!frames.some(frame => frame.type === 'realtime.closed'));
  turn('agent', 'Goodbye, see you later.'); await waitFor(() => frames.some(frame => frame.type === 'realtime.closed'));
  assert.ok(frames.some(frame => frame.type === 'realtime.transcript' && frame.role === 'agent'));
  assert.deepEqual(frames.filter(frame => frame.type === 'realtime.closed'), [{ type: 'realtime.closed', reason: 'ended' }]);
});
test('parent keeps long transcripts, bounds Unicode and routes provider state through the engine emitter', async t => {
  const frames: RealtimeHostFrame[] = []; let socket!: WebSocket;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  server.on('connection', ws => { socket = ws; ws.once('message', () => ws.send(JSON.stringify({ type: 'session.updated' }))); });
  const engine = realtimeEngine({ engine: 'openai', auth: { kind: 'key', key: 'fake-key' }, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bridge: toolBridge({ tools: [], handlers: {}, emit() {}, failure: () => 'Failed' }), emit: frame => frames.push(frame) });
  t.after(() => engine.close()); await waitFor(() => frames.some(frame => frame.type === 'realtime.ready'));
  const transcript = 'A'.repeat(2000);
  socket.send(JSON.stringify({ type: 'response.created', response: { id: 'long' } }));
  socket.send(JSON.stringify({ type: 'response.output_audio_transcript.done', response_id: 'long', transcript }));
  socket.send(JSON.stringify({ type: 'error', error: { message: '界'.repeat(200) } }));
  await waitFor(() => frames.some(frame => frame.type === 'realtime.state' && !!frame.detail));
  assert.ok(frames.some(frame => frame.type === 'realtime.transcript' && frame.text === transcript));
  for (const frame of frames) { parseRealtimeHostFrame(frame); if (frame.type === 'realtime.state' && frame.detail) assert.ok(Buffer.byteLength(frame.detail) <= 500); }
  assert.ok(!frames.some(frame => frame.type === 'realtime.closed'));
});
test('child final refusal reason survives process exit and stdout drain', async t => {
  const server = createServer((_request, response) => { response.writeHead(401); response.end('{"error":{"message":"This saved key has expired."}}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  for (let attempt = 0; attempt < 4; attempt++) {
    const frames: RealtimeHostFrame[] = [];
    const engine = realtimeEngine({ engine: 'openai', auth: { kind: 'key', key: 'fake-key' }, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      bridge: toolBridge({ tools: [], handlers: {}, emit: frame => frames.push(frame), failure: () => 'Failed' }), emit: frame => frames.push(frame) });
    t.after(() => engine.close()); await waitFor(() => frames.some(frame => frame.type === 'realtime.closed'));
    const closed = frames.find(frame => frame.type === 'realtime.closed'); assert.equal(closed?.type, 'realtime.closed');
    if (closed?.type === 'realtime.closed') assert.match(closed.reason!, /This saved key has expired/);
    assert.equal(frames.filter(frame => frame.type === 'realtime.closed').length, 1);
  }
});
test('credential errors retain sanitized app remedies and can use app authFailure wording', async () => {
  for (const custom of [false, true]) {
    const frames: RealtimeHostFrame[] = [];
    const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => { throw new Error('Sign in again from Settings. token=secret-value'); } },
      ...(custom ? { authFailure: () => 'The saved sign-in expired; sign in from Settings.' } : {}),
      bridge: toolBridge({ tools: [], handlers: {}, emit() {}, failure: () => 'Failed' }), emit: frame => frames.push(frame) });
    await engine.ready; engine.close();
    const closed = frames.find(frame => frame.type === 'realtime.closed');
    assert.equal(closed?.type, 'realtime.closed');
    if (closed?.type === 'realtime.closed') assert.match(closed.reason!, custom ? /The saved sign-in expired/ : /Sign in again from Settings/);
    assert.ok(!JSON.stringify(frames).includes('secret-value'));
  }
});
test('ChatGPT prepares media during access, queues early offer until config, and uses explicit signaling identity', async t => {
  const frames: RealtimeHostFrame[] = []; let resolveAccess!: (credential: { access: string; accountId: string }) => void;
  let requests = 0, headers: any;
  const server = createServer(async (request, response) => { requests++; headers = request.headers; const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).sdp, 'v=0\r\ns=early\r\n'); response.end('v=0\r\ns=answer\r\n'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const engine = realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: () => new Promise(resolve => { resolveAccess = resolve; }) },
    signalingIdentity: { originator: 'voice-app', userAgent: 'voice-app/1' }, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bridge: toolBridge({ tools: [], handlers: {}, emit: frame => frames.push(frame), failure: () => 'Failed' }), emit: frame => frames.push(frame) });
  t.after(() => engine.close());
  assert.equal(frames.filter(frame => frame.type === 'realtime.webrtc.start').length, 1);
  engine.receive({ type: 'realtime.webrtc.offer', sdp: 'v=0\r\ns=early\r\n' }); assert.equal(requests, 0);
  resolveAccess({ access: 'fake-token', accountId: 'fake-account' }); await engine.ready;
  await waitFor(() => frames.some(frame => frame.type === 'realtime.webrtc.answer'));
  assert.equal(requests, 1); assert.equal(headers.originator, 'voice-app'); assert.equal(headers['user-agent'], 'voice-app/1');
  assert.equal(headers.authorization, 'Bearer fake-token'); assert.equal(frames.filter(frame => frame.type === 'realtime.webrtc.start').length, 1);
  assert.throws(() => realtimeEngine({ engine: 'chatgpt', auth: { kind: 'plan', access: async () => ({ access: 'x', accountId: 'x' }) },
    signalingIdentity: { originator: 'bad\r\nheader' }, bridge: toolBridge({ tools: [], handlers: {}, emit() {}, failure: () => 'Failed' }), emit() {} }), /protocol/);
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
