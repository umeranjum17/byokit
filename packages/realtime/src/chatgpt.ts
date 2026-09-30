import { cleanProse, cleanProseBytes } from './prose.ts';
import { MAX_REALTIME_SDP_BYTES } from './frames.ts';
import type { RealtimeClientFrame, RealtimeHostFrame } from './frames.ts';
import type { AdapterOptions } from './adapter.ts';
export const CHATGPT_SIGNALING_URL = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas';
function emit(frame: RealtimeHostFrame) { process.stdout.write(`${JSON.stringify(frame)}\n`); }
export async function boundedBody(response: Response, max = MAX_REALTIME_SDP_BYTES): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > max) throw new Error('Voice answer exceeded its limit.'); chunks.push(item.value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export function createChatgptAdapter(options: AdapterOptions & { accountId: string }) {
  const lifetime = new AbortController(); let offered = false, closed = false;
  const safe = (text: unknown) => cleanProse(text, 'Voice could not complete that request.', 4000, options.redact);
  const delegations = new Map<string, Promise<string>>(), turns = new Map<string, Promise<string>>();
  const send = (value: unknown) => emit({ type: 'realtime.webrtc.data', data: JSON.stringify(value) });
  const append = (text: string, id?: string) => {
    const chunks: string[] = []; let chunk = '';
    for (const char of safe(text).slice(0, 8000)) { if (Buffer.byteLength(chunk + char) > 500) { chunks.push(chunk); chunk = ''; } chunk += char; }
    chunks.push(chunk);
    for (const text of chunks) send({ type: id ? 'delegation.context.append' : 'session.context.append', ...(id ? { delegation_item_id: id } : {}), channel: 'speakable', content: [{ type: 'input_text', text }] });
  };
  const close = (reason = 'Voice ended.', retryable = false) => { if (closed) return; closed = true; lifetime.abort(); options.bridge.close(); emit({ type: 'realtime.closed', reason: cleanProseBytes(reason, 'Voice ended.', 2048, options.redact), ...(retryable ? { retryable: true } : {}) }); };
  const signalOffer = async (sdp: string) => {
    if (offered) throw new Error('Duplicate voice offer.'); offered = true;
    const endpoint = options.endpoint ?? CHATGPT_SIGNALING_URL;
    const url = new URL(endpoint);
    if (endpoint !== CHATGPT_SIGNALING_URL && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('Unsupported voice signaling origin.');
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]),
      headers: { Authorization: `Bearer ${options.key}`, 'chatgpt-account-id': options.accountId, originator: options.signalingIdentity?.originator ?? 'byokit', 'User-Agent': options.signalingIdentity?.userAgent ?? 'byokit', 'OpenAI-Alpha': 'quicksilver=v2', 'content-type': 'application/json' },
      body: JSON.stringify({ sdp, session: { model: options.model ?? 'gpt-live-1-codex', instructions: options.instructions, audio: { output: { voice: options.voice ?? 'sol' } }, delegation: { type: 'client', ack_filler: false } } }),
    });
    const answer = await boundedBody(response);
    if (!response.ok) { close(response.status === 401 ? 'signed-out' : response.status === 403 ? 'not-included' : response.status === 429 ? 'rate-limited' : 'network'); return; }
    if (!answer.startsWith('v=0') || answer.includes('\0')) throw new Error('Invalid voice answer.');
    if (!closed) emit({ type: 'realtime.webrtc.answer', sdp: answer });
  };
  const data = async (raw: string) => {
    // Provider event vocabulary stays inside the credential child.
    const event = JSON.parse(raw);
    if (event.type === 'turn.done' && typeof event.turn?.transcript === 'string') {
      const text = cleanProseBytes(event.turn.transcript, '', 4000, options.redact);
      if (!text) return;
      const role = event.turn.role === 'assistant' ? 'agent' : 'user';
      if (role === 'user') emit({ type: 'realtime.audio.clear' });
      emit({ type: 'realtime.transcript', role, text });
      if (role === 'agent') options.bridge.answered();
      options.bridge.state(role === 'agent' ? 'connected' : 'thinking');
    }
    else if (event.type === 'session.started' || event.type === 'session.updated') options.bridge.state('connected');
    else if (event.type === 'output_audio.delta') options.bridge.state('speaking');
    else if (event.type === 'error') close(safe(event.message ?? event.error?.message));
    else if (event.type === 'delegation.created' && event.item?.type === 'delegation' && event.item.target === 'client') {
      const id = event.item.id;
      const request = Array.isArray(event.item.content) ? event.item.content.filter((item: { type?: string; text?: unknown }) => item.type === 'input_text' && typeof item.text === 'string').map((item: { text: string }) => item.text).join('\n') : '';
      if (typeof id !== 'string' || !id || id.length > 128 || Buffer.byteLength(request) > 16000 || delegations.size >= 128 || delegations.has(id)) return;
      const turn = event.item.user_bidi_turn_id;
      const share = typeof turn === 'string' && turn.trim() && turn.length <= 128 ? JSON.stringify([turn.trim(), request.trim()]) : undefined;
      let promise = share ? turns.get(share) : undefined;
      if (!promise) { promise = options.bridge.run('delegate', { request }, `codex:${id}`, lifetime.signal); if (share) turns.set(share, promise); }
      delegations.set(id, promise); const result = await promise; if (!closed) append(result, id);
    }
  };
  return {
    receive(frame: RealtimeClientFrame) {
      if (closed) return;
      if (frame.type === 'realtime.webrtc.offer') void signalOffer(frame.sdp).catch(() => close('Voice signaling failed.'));
      else if (frame.type === 'realtime.webrtc.data') void data(frame.data).catch(() => close('Invalid voice message.'));
      else if (frame.type === 'realtime.say') append(frame.text);
      else if (frame.type === 'realtime.control' && frame.action === 'interrupt') { send({ type: 'session.close' }); close('Voice interrupted.', true); }
      else if (frame.type === 'realtime.control' && frame.action === 'stop') { send({ type: 'session.close' }); close(); }
    }, close,
  };
}
