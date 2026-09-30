import WebSocket from 'ws';
import { cleanProse, providerRefusal as refusal } from '../prose.ts';
import type { AdapterOptions } from '../adapter.ts';
import type { RealtimeClientFrame } from '../frames.ts';
// Lifted wire behavior; this module is loaded only by the kit child process.
export function createAdapter(options: AdapterOptions): {
    receive(frame: RealtimeClientFrame): void;
    close(reason?: string): void;
} {
    const MODEL = options.model ?? 'gemini-3.8-live';
    const ENDPOINT = options.endpoint ?? 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
    const INPUT_RATE = 16000;
    const OUTPUT_RATE = 24000;
    let endAfterResponse = false;
    const providerTools = options.tools.map((tool: any): any => ({ type: 'function', ...tool }));
    const currentContext = '';
    const isExplicitHangup = options.hangup ?? ((): any => false);
    const cleanProviderProse: any = (value: unknown, fallback: string, max: number): any => cleanProse(value, fallback, max, options.redact);
    const providerRefusal: any = (status: number | undefined, body: string): any => refusal(status, body, options.redact);
    const tools = options.bridge;
    const geminiSchema: any = (value: any): any => {
        if (Array.isArray(value))
            return value.map(geminiSchema);
        if (value === null || typeof value !== 'object')
            return value;
        return Object.fromEntries(Object.entries(value)
            .filter(([key]: any): any => key !== 'additionalProperties')
            .map(([key, entry]: any): any => [
            key,
            key === 'type' && typeof entry === 'string' ? entry.toUpperCase() : geminiSchema(entry),
        ]));
    };
    const GEMINI_TOOLS: any = [{
            functionDeclarations: providerTools.map(({ type: _type, ...tool }: any): any => ({ ...tool, parameters: geminiSchema(tool.parameters) })),
        }];
    const OUTPUT_FRAME_MS = 20;
    const AUDIO_CHUNK_SIZE: any = OUTPUT_RATE * 2 * OUTPUT_FRAME_MS / 1000 * 4 / 3;
    const MAX_PENDING_OUTPUT_BYTES: any = 4 * 1024 * 1024;
    const outputQueue: any[] = [];
    let outputBytes = 0;
    let outputBlocked = false;
    let outputTimer: any;
    let outputDeadline = 0;
    let outputPausedByClient = false;
    function syncProviderReadState(): any {
        if (ws?.readyState !== WebSocket.OPEN)
            return;
        if (outputBlocked || outputQueue.length > 0 || outputPausedByClient)
            ws.pause();
        else
            ws.resume();
    }
    function flushOutput(): any {
        outputTimer = undefined;
        if (outputBlocked || outputQueue.length === 0) {
            if (outputQueue.length === 0)
                outputDeadline = 0;
            syncProviderReadState();
            return;
        }
        const index: any = outputPausedByClient ? outputQueue.findIndex((item: any): any => item.force) : 0;
        if (index === -1) {
            syncProviderReadState();
            return;
        }
        const [item] = outputQueue.splice(index, 1);
        outputBytes -= item.line.length;
        outputBlocked = !process.stdout.write(item.line, item.done);
        if (item.delayMs > 0) {
            if (outputDeadline === 0)
                outputDeadline = performance.now();
            outputDeadline += item.delayMs;
        }
        const delayMs: any = item.delayMs > 0 ? Math.max(0, outputDeadline - performance.now()) : 0;
        outputTimer = setTimeout(flushOutput, delayMs);
        syncProviderReadState();
    }
    process.stdout.on('drain', (): any => {
        outputBlocked = false;
        outputDeadline = 0;
        if (outputTimer === undefined)
            flushOutput();
    });
    const emit: any = (frame: any, done: any, force: any = false): any => {
        const line: any = `${JSON.stringify(frame)}\n`;
        if (!force && outputBytes + line.length > MAX_PENDING_OUTPUT_BYTES) {
            stopped = true;
            ws?.close();
            outputQueue.length = 0;
            outputBytes = 0;
            outputDeadline = 0;
            close('Voice output buffer overflowed.', true);
            return false;
        }
        const delayMs: any = frame.type === 'realtime.audio'
            ? Math.max(1, Math.round(frame.data.length / 4 * 3 / (OUTPUT_RATE * 2) * 1000))
            : 0;
        outputQueue.push({ line, delayMs, done, force, audio: frame.type === 'realtime.audio' });
        outputBytes += line.length;
        if (outputTimer === undefined)
            outputTimer = setTimeout(flushOutput, 0);
        syncProviderReadState();
        return true;
    };
    function clearQueuedAudio(): any {
        for (let index: any = outputQueue.length - 1; index >= 0; index -= 1) {
            if (!outputQueue[index].audio)
                continue;
            outputBytes -= outputQueue[index].line.length;
            outputQueue.splice(index, 1);
        }
        if (!outputQueue.some((item: any): any => item.audio))
            outputDeadline = 0;
    }
    // Gemini can deliver several seconds in one provider event. Twenty-millisecond
    // frames keep native admission smooth while the paced queue backpressures the
    // provider WebSocket whenever the phone or app is not draining.
    function chunkAudio(audio: any): any {
        const chunks: any[] = [];
        for (let offset = 0; offset < audio.length; offset += AUDIO_CHUNK_SIZE)
            chunks.push(audio.slice(offset, offset + AUDIO_CHUNK_SIZE));
        return chunks;
    }
    const emitAudio: any = (audio: any): any => {
        for (const data of chunkAudio(audio)) {
            if (!emit({ type: 'realtime.audio', data }))
                break;
        }
    };
    const state: any = (value: any, detail: any): any => tools.state(value, detail);
    const PROMPT = options.instructions;
    let closing = false;
    const close: any = (reason: any, force: any = false): any => {
        if (closing)
            return;
        closing = true;
        tools.close();
        emit({ type: 'realtime.closed', reason }, (): any => process.exit(0), force);
    };
    let ws: WebSocket | undefined;
    let stopped = false;
    let providerReady = false;
    let sessionHandle = '';
    const cancelledToolCalls: any = new Set();
    const activeToolCalls: any = new Map();
    let providerReconnects = 0;
    let reconnectTimer: any;
    let stableTimer: any;
    /** A provider link alive this long was healthy; forget its retries. */
    const PROVIDER_STABLE_AFTER_MS = 30000;
    const text: any = (value: any): any => String(value ?? '').trim();
    function providerError(error: any): any {
        const raw: any = typeof error === 'string' ? error : error?.message ?? error?.code ?? 'provider error';
        const detail: any = cleanProviderProse(raw, 'provider error', 200);
        return { detail, terminal: /api key|auth|credit|quota|billing|permission|forbidden|invalid json|invalid payload|unknown name|unsupported/i.test(detail) };
    }
    const runTool: any = (name: any, input: any, operationId: any, signal: any): any => tools.run(name, input, operationId, signal);
    let inputTranscript = '';
    let outputTranscript = '';
    let turnThinking = false;
    let finishTimer: any;
    function finishTurn(): any {
        if (outputTranscript.trim())
            tools.answered();
        if (isExplicitHangup(inputTranscript))
            endAfterResponse = true;
        if (inputTranscript.trim())
            emit({ type: 'realtime.transcript', role: 'user', text: inputTranscript.trim() });
        if (outputTranscript.trim())
            emit({ type: 'realtime.transcript', role: 'agent', text: outputTranscript.trim() });
        inputTranscript = '';
        outputTranscript = '';
        turnThinking = false;
        if (endAfterResponse) {
            stopped = true;
            ws?.close();
            close('ended', true);
        }
        else {
            state('connected');
        }
    }
    function handleGeminiEvent(raw: any): any {
        let message: any;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (message.setupComplete) {
            providerReady = true;
            emit({ type: 'realtime.ready', inputRate: INPUT_RATE, outputRate: OUTPUT_RATE });
            state('connected', providerReconnects === 0 ? undefined : 'Voice provider reconnected');
            clearTimeout(stableTimer);
            stableTimer = setTimeout((): any => { providerReconnects = 0; }, PROVIDER_STABLE_AFTER_MS);
        }
        if (message.usageMetadata) emit({ type: 'realtime.usage', usage: { seconds: 0, basis: 'tokens', inputTokens: message.usageMetadata.promptTokenCount ?? 0, outputTokens: message.usageMetadata.responseTokenCount ?? 0 } });
    const content: any = message.serverContent;
        if (content) {
            if (content.interrupted === true) {
                clearQueuedAudio();
                emit({ type: 'realtime.audio.clear' }, undefined, true);
            }
            if (typeof content.inputTranscription?.text === 'string')
                inputTranscript += content.inputTranscription.text;
            if (typeof content.outputTranscription?.text === 'string')
                outputTranscript += content.outputTranscription.text;
            for (const part of content.modelTurn?.parts ?? []) {
                const audio: any = part.inlineData?.data;
                if (typeof audio === 'string' && audio) {
                    if (!turnThinking) {
                        state('thinking');
                        turnThinking = true;
                    }
                    emitAudio(audio);
                }
            }
            if (content.turnComplete === true) {
                // Transcription chunks are independent and have no final bit; give late chunks one short grace window.
                clearTimeout(finishTimer);
                finishTimer = setTimeout(finishTurn, 150);
            }
        }
        if (typeof message.sessionResumptionUpdate?.newHandle === 'string' && message.sessionResumptionUpdate.resumable === true) {
            sessionHandle = message.sessionResumptionUpdate.newHandle;
        }
        if (Array.isArray(message.toolCallCancellation?.ids)) {
            // ponytail: completed Herdr side effects cannot be undone; cancellation aborts work still in flight.
            for (const id of message.toolCallCancellation.ids) {
                cancelledToolCalls.add(id);
                activeToolCalls.get(id)?.abort();
            }
        }
        if (Array.isArray(message.toolCall?.functionCalls)) {
            void (async (): Promise<any> => {
                const functionResponses: any = (await Promise.all(message.toolCall.functionCalls.map(async (call: any): Promise<any> => {
                    if (cancelledToolCalls.delete(call.id))
                        return undefined;
                    const controller: any = new AbortController();
                    activeToolCalls.set(call.id, controller);
                    let output: any;
                    try {
                        output = await runTool(call.name, call.args, call.id, controller.signal);
                    }
                    catch (error: any) {
                        if (cancelledToolCalls.delete(call.id) || error?.name === 'AbortError')
                            return undefined;
                        output = 'The request could not be completed. Please try again.';
                    }
                    finally {
                        activeToolCalls.delete(call.id);
                    }
                    if (cancelledToolCalls.delete(call.id))
                        return undefined;
                    return { id: call.id, name: call.name, response: { result: text(output).slice(0, 24000) } };
                }))).filter(Boolean);
                if (stopped || ws?.readyState !== WebSocket.OPEN || functionResponses.length === 0)
                    return;
                ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
            })();
        }
        if (message.goAway && ws?.readyState === WebSocket.OPEN) {
            const current: any = ws;
            const milliseconds: any = Math.max(0, (Number.parseFloat(message.goAway.timeLeft) || 1) * 1000 - 500);
            setTimeout((): any => { if (!stopped && ws === current)
                current.close(1000, 'Session rotation'); }, milliseconds);
        }
        if (message.error) {
            const { detail, terminal } = providerError(message.error);
            if (!providerReady || terminal) {
                stopped = true;
                ws?.close();
                close(`Voice provider error: ${detail}`, true);
            }
            else {
                state('connected', detail);
            }
        }
    }
    function handleClientFrame(frame: any): any {
        if (tools.receive(frame))
            return;
        if (frame.type === 'realtime.control') {
            if (frame.action === 'stop') {
                stopped = true;
                ws?.close();
                outputQueue.length = 0;
                outputBytes = 0;
                outputDeadline = 0;
                close('ended', true);
            }
            else if (frame.action === 'pause_output') {
                outputPausedByClient = true;
                outputDeadline = 0;
                syncProviderReadState();
            }
            else if (frame.action === 'resume_output') {
                outputPausedByClient = false;
                if (outputTimer === undefined)
                    outputTimer = setTimeout(flushOutput, 0);
                syncProviderReadState();
            }
            return;
        }
        if (ws?.readyState !== WebSocket.OPEN)
            return;
        if (frame.type === 'realtime.audio') {
            ws.send(JSON.stringify({ realtimeInput: { audio: { data: frame.data, mimeType: `audio/pcm;rate=${INPUT_RATE}` } } }));
        }
        else if (frame.type === 'realtime.say') {
            ws.send(JSON.stringify({
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text: frame.text }] }],
                    turnComplete: true,
                },
            }));
        }
        // mute/unmute are enforced on the phone's capture side; nothing to forward.
    }
    function connectProvider(key: any): any {
        if (stopped)
            return;
        providerReady = false;
        state('connecting', providerReconnects === 0 ? undefined : 'Voice provider reconnecting');
        const current: any = new WebSocket(`${ENDPOINT}?key=${encodeURIComponent(key)}`, { maxPayload: 4 * 1024 * 1024 });
        ws = current;
        const onDown: any = (reason: any): any => {
            if (stopped || ws !== current)
                return;
            if (providerReconnects >= 2) {
                close(reason, true);
                return;
            }
            providerReconnects += 1;
            reconnectTimer = setTimeout((): any => connectProvider(key), providerReconnects * 500);
        };
        current.on('open', (): any => {
            if (stopped || ws !== current)
                return;
            current.send(JSON.stringify({
                setup: {
                    model: `models/${MODEL}`,
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice ?? 'Kore' } } },
                    },
                    systemInstruction: { parts: [{ text: PROMPT + currentContext }] },
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    sessionResumption: sessionHandle ? { handle: sessionHandle } : {},
                    contextWindowCompression: { slidingWindow: {} },
                    tools: GEMINI_TOOLS,
                },
            }));
        });
        current.on('message', (data: any): any => { if (ws === current)
            handleGeminiEvent(String(data)); });
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
                    close(reason, true);
                else
                    onDown(reason);
            });
        });
        current.on('close', (code: any, reasonBuffer: any): any => {
            const reason: any = cleanProviderProse(String(reasonBuffer), '', 160);
            const detail: any = `The voice provider disconnected (${code})${reason ? `: ${reason}` : '.'}`;
            if (providerError(reason).terminal) {
                stopped = true;
                close(detail, true);
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
