import WebSocket from 'ws';
import { cleanProse, providerRefusal as refusal } from '../prose.ts';
import type { AdapterOptions } from '../adapter.ts';
import type { RealtimeClientFrame } from '../frames.ts';
// Lifted wire behavior; this module is loaded only by the kit child process.
export function createAdapter(options: AdapterOptions): {
    receive(frame: RealtimeClientFrame): void;
    close(reason?: string): void;
} {
    const MODEL = options.model ?? 'gpt-realtime-2.1';
    const RATE = 24000;
    const PROVIDER_URL = options.endpoint ?? `wss://api.openai.com/v1/realtime?model=${MODEL}`;
    let endAfterResponse = false;
    const providerTools = options.tools.map((tool: any): any => ({ type: 'function', ...tool }));
    const currentContext = '';
    const isExplicitHangup = options.hangup ?? ((): any => false);
    const cleanProviderProse: any = (value: unknown, fallback: string, max: number): any => cleanProse(value, fallback, max, options.redact);
    const providerRefusal: any = (status: number | undefined, body: string): any => refusal(status, body, options.redact);
    const tools = options.bridge;
    const emit: any = (frame: any): any => process.stdout.write(`${JSON.stringify(frame)}\n`);
    // Provider deltas may exceed the public frame bound after tool calls. Base64 is
    // independently decodable when split on four-character boundaries.
    function chunkAudio(audio: any): any {
        const chunks: any[] = [];
        const chunkSize: any = 64 * 1024;
        for (let offset = 0; offset < audio.length; offset += chunkSize)
            chunks.push(audio.slice(offset, offset + chunkSize));
        return chunks;
    }
    const emitAudio: any = (audio: any): any => {
        for (const data of chunkAudio(audio))
            emit({ type: 'realtime.audio', data });
    };
    const state: any = (value: any, detail: any): any => tools.state(value, detail);
    const PROMPT = options.instructions;
    let closing = false;
    const close: any = (reason: any): any => {
        if (closing)
            return;
        closing = true;
        tools.close();
        process.stdout.write(`${JSON.stringify({ type: 'realtime.closed', reason })}\n`, (): any => process.exit(0));
    };
    let ws: WebSocket | undefined;
    let stopped = false;
    let providerReady = false;
    const text: any = (value: any): any => String(value ?? '').trim();
    function providerError(error: any): any {
        const raw: any = typeof error === 'string' ? error : error?.message ?? error?.code ?? 'provider error';
        const detail: any = cleanProviderProse(raw, 'provider error', 200);
        return { detail, terminal: /api key|auth|credit|quota|billing|permission|forbidden|invalid json|invalid payload|unknown name|unsupported/i.test(detail) };
    }
    const runTool: any = (name: any, input: any, operationId: any, signal: any): any => tools.run(name, input, operationId, signal);
    const pendingToolCalls: any = new Map();
    function handleOpenAiEvent(raw: any): any {
        let message: any;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        switch (message.type) {
            case 'session.updated':
                providerReady = true;
                emit({ type: 'realtime.ready', inputRate: RATE, outputRate: RATE });
                state('connected');
                break;
            case 'input_audio_buffer.speech_started':
                // ponytail: the generic stream has no playback clock; add a playback-progress frame before truncating provider history.
                emit({ type: 'realtime.audio.clear' });
                break;
            case 'response.created':
                state('thinking');
                break;
            case 'response.output_audio.delta':
            case 'response.audio.delta': {
                const audio: any = typeof message.delta === 'string' ? message.delta : typeof message.audio === 'string' ? message.audio : '';
                if (audio)
                    emitAudio(audio);
                break;
            }
            case 'response.done': {
            if (message.response?.usage) emit({ type: 'realtime.usage', usage: { seconds: 0, basis: 'tokens', inputTokens: message.response.usage.input_tokens ?? 0, outputTokens: message.response.usage.output_tokens ?? 0, audioInTokens: message.response.usage.input_token_details?.audio_tokens ?? 0, audioOutTokens: message.response.usage.output_token_details?.audio_tokens ?? 0, cachedTokens: message.response.usage.input_token_details?.cached_tokens ?? 0 } });
                const responseId: any = message.response?.id;
                const calls: any = typeof responseId === 'string' ? pendingToolCalls.get(responseId) ?? [] : [];
                if (typeof responseId === 'string')
                    pendingToolCalls.delete(responseId);
                if (message.response?.status === 'completed' && calls.length > 0) {
                    void (async (): Promise<any> => {
                        const outputs: any[] = [];
                        for (const call of calls) {
                            let output: any;
                            try {
                                output = await runTool(call.name, call.args, call.callId);
                            }
                            catch {
                                output = 'The request could not be completed. Please try again.';
                            }
                            outputs.push({ callId: call.callId, output });
                        }
                        if (stopped || ws?.readyState !== WebSocket.OPEN)
                            return;
                        for (const output of outputs) {
                            ws.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: { type: 'function_call_output', call_id: output.callId, output: text(output.output).slice(0, 24000) },
                            }));
                        }
                        ws.send(JSON.stringify({ type: 'response.create' }));
                    })();
                }
                else if (message.response?.status === 'completed' && endAfterResponse) {
                    stopped = true;
                    ws?.close();
                    close('ended');
                }
                else {
                    state('connected');
                }
                break;
            }
            case 'conversation.item.input_audio_transcription.completed':
                if (typeof message.transcript === 'string' && message.transcript.trim() !== '') {
                    if (isExplicitHangup(message.transcript))
                        endAfterResponse = true;
                    emit({ type: 'realtime.transcript', role: 'user', text: message.transcript });
                }
                break;
            case 'response.output_audio_transcript.done':
                if (typeof message.transcript === 'string' && message.transcript.trim() !== '') {
                    tools.answered();
                    emit({ type: 'realtime.transcript', role: 'agent', text: message.transcript });
                }
                break;
            case 'response.function_call_arguments.done': {
                if (typeof message.response_id !== 'string')
                    break;
                let args: any = {};
                try {
                    args = JSON.parse(message.arguments || '{}');
                }
                catch { /* interrupted arguments */ }
                const calls: any = pendingToolCalls.get(message.response_id) ?? [];
                calls.push({ name: message.name, callId: message.call_id, args });
                pendingToolCalls.set(message.response_id, calls);
                break;
            }
            case 'error': {
                const { detail, terminal } = providerError(message.error);
                if (!providerReady || terminal) {
                    stopped = true;
                    ws?.close();
                    close(`Voice provider error: ${detail}`);
                }
                else {
                    state('connected', detail);
                }
                break;
            }
        }
    }
    function handleClientFrame(frame: any): any {
        if (tools.receive(frame))
            return;
        if (ws?.readyState !== WebSocket.OPEN)
            return;
        if (frame.type === 'realtime.audio') {
            ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.data }));
        }
        else if (frame.type === 'realtime.say') {
            ws.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: frame.text }] },
            }));
            ws.send(JSON.stringify({ type: 'response.create' }));
        }
        else if (frame.type === 'realtime.control' && frame.action === 'stop') {
            stopped = true;
            ws.close();
            close('ended');
        }
        // mute/unmute are enforced on the phone's capture side; nothing to forward.
    }
    function connectProvider(key: any): any {
        if (stopped)
            return;
        state('connecting');
        const current: any = new WebSocket(PROVIDER_URL, {
            headers: { Authorization: `Bearer ${key}` },
            maxPayload: 4 * 1024 * 1024,
        });
        ws = current;
        const onDown: any = (reason: any): any => {
            if (stopped || ws !== current)
                return;
            stopped = true;
            close(reason);
        };
        current.on('open', (): any => {
            if (stopped || ws !== current)
                return;
            current.send(JSON.stringify({
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: MODEL,
                    instructions: PROMPT + currentContext,
                    output_modalities: ['audio'],
                    audio: {
                        input: {
                            format: { type: 'audio/pcm', rate: RATE },
                            transcription: { model: 'gpt-4o-mini-transcribe' },
                            turn_detection: {
                                type: 'server_vad',
                                threshold: 0.9,
                                silence_duration_ms: 700,
                                prefix_padding_ms: 300,
                                create_response: true,
                                interrupt_response: true,
                            },
                        },
                        output: { format: { type: 'audio/pcm' }, voice: options.voice ?? 'marin' },
                    },
                    tools: providerTools,
                },
            }));
        });
        current.on('message', (data: any): any => { if (ws === current)
            handleOpenAiEvent(String(data)); });
        // ws suppresses 'error' and 'close' once this is handled, so the failure
        // path is driven from here. Auth and permission refusals are terminal:
        // retrying an out-of-credits account only delays the real message.
        current.on('unexpected-response', (_request: any, response: any): any => {
            let body = '';
            response.on('data', (chunk: any): any => { if (Buffer.byteLength(body) + chunk.length > 16384) { response.destroy(); current.terminate(); close('Voice provider refusal exceeded its limit.'); return; } body += chunk; });
            response.on('end', (): any => {
                current.terminate();
                if (stopped || ws !== current)
                    return;
                const reason: any = providerRefusal(response.statusCode, body);
                if (response.statusCode === 401 || response.statusCode === 403)
                    close(reason);
                else
                    onDown(reason);
            });
        });
        current.on('close', (code: any, reasonBuffer: any): any => {
            const reason: any = cleanProviderProse(String(reasonBuffer), '', 160);
            const detail: any = `OpenAI session ended (${code})${reason ? `: ${reason}` : '.'}`;
            if (providerError(reason).terminal) {
                stopped = true;
                close(detail);
            }
            else {
                onDown(detail);
            }
        });
        current.on('error', (error: any): any => {
            if (!stopped && ws === current)
                state('connecting', `Voice provider connection interrupted: ${cleanProviderProse(error.message, 'connection error', 160)}`);
        });
    }
    connectProvider(options.key);
    return { receive: handleClientFrame, close: (reason: any = 'ended'): any => { stopped = true; ws?.close(); close(reason); } };
}
