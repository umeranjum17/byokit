import WebSocket from 'ws';
import { cleanProse, providerRefusal as refusal } from '../prose.ts';
import type { AdapterOptions } from '../adapter.ts';
import type { RealtimeClientFrame } from '../frames.ts';
// Lifted wire behavior; this module is loaded only by the kit child process.
export function createAdapter(options: AdapterOptions): {
    receive(frame: RealtimeClientFrame): void;
    close(reason?: string): void;
} {
    const MODEL = options.model ?? 'grok-voice-think-fast-2.0';
    const RATE = 24000;
    const PROVIDER_URL = options.endpoint ?? `wss://api.x.ai/v1/realtime?model=${MODEL}`;
    let endAfterResponse = false;
    const providerTools = options.tools.map((tool: any): any => ({ type: 'function', ...tool }));
    const currentContext = '';
    const isExplicitHangup = options.hangup ?? ((): any => false);
    const cleanProviderProse: any = (value: unknown, fallback: string, max: number): any => cleanProse(value, fallback, max, options.redact);
    const providerRefusal: any = (status: number | undefined, body: string): any => refusal(status, body, options.redact);
    const MAX_STDOUT_BYTES: any = 256 * 1024;
    const MAX_REFUSAL_BODY_BYTES: any = 16 * 1024;
    const stdoutQueue: any[] = [];
    let stdoutBytes = 0;
    let stdoutBlocked = false;
    let stdoutOverflowed = false;
    function syncProviderReadState(): any {
        if (ws?.readyState !== WebSocket.OPEN)
            return;
        if (stdoutBlocked || stdoutQueue.length > 0 || outputPausedByClient)
            ws.pause();
        else
            ws.resume();
    }
    const flushStdout: any = (): any => {
        while (!stdoutBlocked && stdoutQueue.length > 0) {
            const item: any = stdoutQueue.shift();
            stdoutBytes -= item.line.length;
            stdoutBlocked = !process.stdout.write(item.line, item.done);
        }
        syncProviderReadState();
    };
    process.stdout.on('drain', (): any => { stdoutBlocked = false; flushStdout(); });
    const emit: any = (frame: any, done: any, force: any = false): any => {
        const line: any = `${JSON.stringify(frame)}\n`;
        if (!force && stdoutBytes + line.length > MAX_STDOUT_BYTES) {
            if (!stdoutOverflowed) {
                stdoutOverflowed = true;
                stopped = true;
                ws?.close();
                close('Voice output buffer overflowed.', true);
            }
            return false;
        }
        if (!stdoutBlocked && stdoutQueue.length === 0) {
            stdoutBlocked = !process.stdout.write(line, done);
            syncProviderReadState();
        }
        else {
            stdoutQueue.push({ line, done });
            stdoutBytes += line.length;
            syncProviderReadState();
        }
        return true;
    };
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
        let emitted = false;
        for (const data of chunkAudio(audio))
            emitted = emit({ type: 'realtime.audio', data }) || emitted;
        return emitted;
    };
    const state: any = (value: any, detail: any): any => tools.state(value, detail);
    const PROMPT = options.instructions;
    const tools = options.bridge;
    let closing = false;
    const close: any = (reason: any, forceExit: any = false): any => {
        if (closing)
            return;
        closing = true;
        clearTimeout(reconnectTimer);
        clearTimeout(stableTimer);
        tools.close();
        clearTimeout(inputPoll);
        const timer: any = setTimeout((): any => process.exit(forceExit ? 1 : 0), 1000);
        emit({ type: 'realtime.closed', reason }, (): any => {
            clearTimeout(timer);
            process.exit(forceExit ? 1 : 0);
        }, true);
        flushStdout();
    };
    let ws: WebSocket | undefined;
    let stopped = false;
    let providerReconnects = 0;
    let reconnectTimer: any;
    let stableTimer: any;
    let providerEpoch = 0;
    let providerReady = false;
    let inputPoll: any;
    let outputFenced = false;
    let responseActive = false;
    let responseGeneration = 0;
    let clearedGeneration: any = -1;
    let deferredClearGeneration: any;
    let deferredClearContinuation: any;
    let deferredClearPending = false;
    const playbackGenerations: any = new Set();
    const playbackDrainQueue: any[] = [];
    let gracefulEndPending = false;
    let outputPausedByClient = false;
    const MAX_INPUT_BYTES = 96000;
    const PROVIDER_BUFFER_LIMIT: any = 512 * 1024;
    const clientQueue: any[] = [];
    let clientQueueBytes = 0;
    let inputOverflowPending = false;
    /** A provider link alive this long was healthy; forget its retries. */
    const PROVIDER_STABLE_AFTER_MS = 30000;
    const text: any = (value: any): any => String(value ?? '').trim();
    function providerError(error: any): any {
        const raw: any = typeof error === 'string' ? error : error?.message ?? error?.code ?? 'provider error';
        const detail: any = cleanProviderProse(raw, 'provider error', 200);
        return { detail, terminal: /api key|auth|credit|quota|billing|permission|forbidden|invalid json|invalid payload|unknown name|unsupported/i.test(detail) };
    }
    const runTool: any = (name: any, input: any, operationId: any): any => tools.run(name, input, operationId);
    const currentProvider: any = (current: any, epoch: any): any => !stopped && ws === current && providerEpoch === epoch;
    const finishGracefulEndIfDrained: any = (): any => {
        if (!gracefulEndPending || playbackDrainQueue.length > 0 || deferredClearPending)
            return;
        stopped = true;
        ws?.close();
        close('ended');
    };
    const continueAfterClear: any = (continuation: any): any => {
        if (gracefulEndPending)
            finishGracefulEndIfDrained();
        else
            continuation?.();
    };
    const finishDeferredClearIfDrained: any = (): any => {
        if (!deferredClearPending || playbackDrainQueue.length > 0)
            return;
        const generation: any = deferredClearGeneration;
        const continuation: any = deferredClearContinuation;
        deferredClearPending = false;
        deferredClearGeneration = undefined;
        deferredClearContinuation = undefined;
        if (generation !== undefined)
            playbackGenerations.delete(generation);
        if (generation !== undefined && clearedGeneration !== generation) {
            clearedGeneration = generation;
            emit({ type: 'realtime.audio.clear' });
        }
        syncProviderReadState();
        continueAfterClear(continuation);
    };
    const clearIncompleteOutput: any = (): any => {
        outputFenced = true;
        responseActive = false;
        const continuation: any = deferredClearContinuation;
        deferredClearPending = false;
        deferredClearGeneration = undefined;
        deferredClearContinuation = undefined;
        playbackGenerations.clear();
        playbackDrainQueue.length = 0;
        if (clearedGeneration !== responseGeneration) {
            clearedGeneration = responseGeneration;
            emit({ type: 'realtime.audio.clear' });
        }
        syncProviderReadState();
        continueAfterClear(continuation);
    };
    const fenceActiveResponse: any = (continuation: any): any => {
        outputFenced = true;
        if (!responseActive) {
            if (deferredClearPending || playbackDrainQueue.length > 0) {
                deferredClearPending = true;
                deferredClearContinuation = continuation;
            }
            else
                continueAfterClear(continuation);
            return;
        }
        responseActive = false;
        if (!playbackGenerations.has(responseGeneration)) {
            if (playbackDrainQueue.length > 0) {
                deferredClearPending = true;
                deferredClearContinuation = continuation;
            }
            else
                continueAfterClear(continuation);
        }
        else if (playbackDrainQueue.length > 0) {
            deferredClearPending = true;
            deferredClearGeneration = responseGeneration;
            deferredClearContinuation = continuation;
            syncProviderReadState();
        }
        else {
            playbackGenerations.delete(responseGeneration);
            if (clearedGeneration !== responseGeneration) {
                clearedGeneration = responseGeneration;
                emit({ type: 'realtime.audio.clear' });
            }
            continueAfterClear(continuation);
        }
    };
    const deliverAfterClear: any = (continuation: any): any => {
        if (deferredClearPending || playbackDrainQueue.length > 0) {
            deferredClearPending = true;
            deferredClearContinuation = continuation;
        }
        else
            continueAfterClear(continuation);
    };
    function handleXaiEvent(raw: any, current: any, epoch: any): any {
        if (!currentProvider(current, epoch))
            return;
        let message: any;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (deferredClearPending && message.type !== 'input_audio_buffer.speech_started' && message.type !== 'error')
            return;
        switch (message.type) {
            case 'input_audio_buffer.speech_started':
                if (playbackGenerations.size > 0 && clearedGeneration !== responseGeneration)
                    clearIncompleteOutput();
                break;
            case 'response.created':
                responseGeneration += 1;
                responseActive = true;
                outputFenced = false;
                state('thinking');
                break;
            case 'response.output_audio.delta':
            case 'response.audio.delta': {
                const audio: any = typeof message.delta === 'string' ? message.delta : typeof message.audio === 'string' ? message.audio : '';
                if (audio && !outputFenced && emitAudio(audio))
                    playbackGenerations.add(responseGeneration);
                break;
            }
            case 'response.done':
                if (!responseActive)
                    break;
                responseActive = false;
                if (playbackGenerations.has(responseGeneration) && !playbackDrainQueue.includes(responseGeneration)) {
                    playbackDrainQueue.push(responseGeneration);
                }
                state('connected');
                if (endAfterResponse) {
                    gracefulEndPending = true;
                    finishGracefulEndIfDrained();
                }
                break;
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
                const callGeneration: any = responseGeneration;
                void (async (): Promise<any> => {
                    let args: any = {};
                    try {
                        args = JSON.parse(message.arguments || '{}');
                    }
                    catch { /* interrupted arguments */ }
                    let output: any;
                    try {
                        output = await runTool(message.name, args, message.call_id);
                    }
                    catch {
                        output = 'The request could not be completed. Please try again.';
                    }
                    if (!currentProvider(current, epoch) || current.readyState !== WebSocket.OPEN || outputFenced || callGeneration !== responseGeneration)
                        return;
                    current.send(JSON.stringify({
                        type: 'conversation.item.create',
                        item: { type: 'function_call_output', call_id: message.call_id, output: text(output).slice(0, 24000) },
                    }));
                    if (currentProvider(current, epoch) && !outputFenced && callGeneration === responseGeneration)
                        current.send(JSON.stringify({ type: 'response.create' }));
                })();
                break;
            }
            case 'error': {
                const { detail, terminal } = providerError(message.error);
                if (terminal) {
                    providerReady = false;
                    if (endAfterResponse)
                        gracefulEndPending = true;
                    fenceActiveResponse((): any => close(`Voice provider error: ${detail}`));
                    stopped = true;
                    current.close();
                }
                else {
                    if (endAfterResponse)
                        gracefulEndPending = true;
                    fenceActiveResponse((): any => state('connected', detail));
                }
                break;
            }
        }
    }
    function sendClientFrame(current: any, frame: any): any {
        if (frame.type === 'realtime.audio') {
            current.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.data }));
        }
        else if (frame.type === 'realtime.say') {
            current.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: frame.text }] },
            }));
            current.send(JSON.stringify({ type: 'response.create' }));
        }
    }
    function flushClientFrames(current: any = ws, epoch: any = providerEpoch): any {
        clearTimeout(inputPoll);
        inputPoll = undefined;
        if (!current || !currentProvider(current, epoch) || !providerReady || current.readyState !== WebSocket.OPEN)
            return;
        while (clientQueue.length > 0 && current.bufferedAmount <= PROVIDER_BUFFER_LIMIT) {
            const item: any = clientQueue.shift();
            clientQueueBytes -= item.bytes;
            sendClientFrame(current, item.frame);
        }
        if (clientQueue.length > 0)
            inputPoll = setTimeout((): any => flushClientFrames(current, epoch), 20);
    }
    const clientFrameBytes: any = (frame: any): any => frame.type === 'realtime.audio'
        ? Math.floor(frame.data.length * 3 / 4)
        : Buffer.byteLength(JSON.stringify(frame));
    function handleClientFrame(frame: any): any {
        if (tools.receive(frame))
            return;
        if (frame.type === 'realtime.control') {
            if (frame.action === 'stop') {
                stopped = true;
                ws?.close();
                close('ended');
            }
            else if (frame.action === 'pause_output') {
                outputPausedByClient = true;
                syncProviderReadState();
            }
            else if (frame.action === 'resume_output') {
                outputPausedByClient = false;
                syncProviderReadState();
            }
            else if (frame.action === 'output_drained') {
                const drainedGeneration: any = playbackDrainQueue.shift();
                if (drainedGeneration !== undefined)
                    playbackGenerations.delete(drainedGeneration);
                finishDeferredClearIfDrained();
                finishGracefulEndIfDrained();
            }
            return;
        }
        if (inputOverflowPending)
            return;
        if (frame.type !== 'realtime.audio' && frame.type !== 'realtime.say')
            return;
        const bytes: any = clientFrameBytes(frame);
        if (clientQueueBytes + bytes > MAX_INPUT_BYTES) {
            inputOverflowPending = true;
            providerReady = false;
            clearTimeout(inputPoll);
            inputPoll = undefined;
            fenceActiveResponse((): any => close('Voice input buffer overflowed.'));
            stopped = true;
            ws?.close();
            return;
        }
        clientQueue.push({ frame, bytes });
        clientQueueBytes += bytes;
        flushClientFrames();
        // mute/unmute are enforced on the phone's capture side; nothing to forward.
    }
    function connectProvider(key: any): any {
        if (stopped)
            return;
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        clearTimeout(stableTimer);
        stableTimer = undefined;
        providerReady = false;
        const epoch: any = ++providerEpoch;
        deliverAfterClear((): any => state('connecting', providerReconnects === 0 ? undefined : 'Voice provider reconnecting'));
        const current: any = new WebSocket(PROVIDER_URL, {
            headers: { Authorization: `Bearer ${key}` },
            maxPayload: 4 * 1024 * 1024,
        });
        ws = current;
        let downHandled = false;
        const onDown: any = (reason: any): any => {
            if (downHandled || stopped || ws !== current || providerEpoch !== epoch)
                return;
            downHandled = true;
            providerReady = false;
            clearTimeout(stableTimer);
            stableTimer = undefined;
            clearTimeout(inputPoll);
            inputPoll = undefined;
            if (endAfterResponse)
                gracefulEndPending = true;
            fenceActiveResponse(providerReconnects >= 2 ? (): any => close(reason) : undefined);
            if (!gracefulEndPending && providerReconnects < 2) {
                providerReconnects += 1;
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout((): any => connectProvider(key), providerReconnects * 500);
            }
        };
        current.on('open', (): any => {
            if (!currentProvider(current, epoch))
                return;
            syncProviderReadState();
            current.send(JSON.stringify({
                type: 'session.update',
                session: {
                    instructions: PROMPT + currentContext,
                    voice: options.voice ?? 'ara',
                    reasoning: { effort: 'none' },
                    turn_detection: { type: 'server_vad', threshold: 0.9, silence_duration_ms: 700, prefix_padding_ms: 300 },
                    audio: {
                        input: { format: { type: 'audio/pcm', rate: RATE }, transport: 'json' },
                        output: { format: { type: 'audio/pcm', rate: RATE }, transport: 'json' },
                    },
                    tools: providerTools,
                },
            }), (error: any): any => {
                if (error) {
                    onDown('Voice provider session setup failed.');
                    return;
                }
                if (!currentProvider(current, epoch))
                    return;
                providerReady = true;
                flushClientFrames(current, epoch);
                deliverAfterClear((): any => {
                    emit({ type: 'realtime.ready', inputRate: RATE, outputRate: RATE });
                    state('connected', providerReconnects === 0 ? undefined : 'Voice provider reconnected');
                });
                // Reconnect budget is consecutive, not cumulative: a long healthy
                // call gets the full budget again after its next transient drop.
                clearTimeout(stableTimer);
                stableTimer = setTimeout((): any => {
                    if (currentProvider(current, epoch))
                        providerReconnects = 0;
                }, PROVIDER_STABLE_AFTER_MS);
            });
        });
        current.on('message', (data: any): any => handleXaiEvent(String(data), current, epoch));
        // ws suppresses 'error' and 'close' once this is handled, so the failure
        // path is driven from here. Auth and permission refusals are terminal:
        // retrying an out-of-credits account only delays the real message.
        current.on('unexpected-response', (_request: any, response: any): any => {
            const bodyBuffer: any = Buffer.alloc(MAX_REFUSAL_BODY_BYTES);
            let bodyBytes = 0;
            response.on('data', (chunk: any): any => {
                const admitted: any = Math.min(chunk.length, MAX_REFUSAL_BODY_BYTES - bodyBytes);
                if (admitted > 0)
                    bodyBytes += chunk.copy(bodyBuffer, bodyBytes, 0, admitted);
            });
            response.on('end', (): any => {
                if (!currentProvider(current, epoch))
                    return;
                const body: any = bodyBuffer.subarray(0, bodyBytes).toString('utf8');
                const reason: any = providerRefusal(response.statusCode, body);
                if (response.statusCode === 401 || response.statusCode === 403) {
                    providerReady = false;
                    if (endAfterResponse)
                        gracefulEndPending = true;
                    fenceActiveResponse((): any => close(reason));
                    stopped = true;
                }
                else
                    onDown(reason);
                current.terminate();
            });
        });
        current.on('close', (code: any, reasonBuffer: any): any => {
            const reason: any = cleanProviderProse(String(reasonBuffer), '', 160);
            const detail: any = `The voice provider disconnected (${code})${reason ? `: ${reason}` : '.'}`;
            if (providerError(reason).terminal) {
                providerReady = false;
                if (endAfterResponse)
                    gracefulEndPending = true;
                fenceActiveResponse((): any => close(detail));
                stopped = true;
            }
            else {
                onDown(detail);
            }
        });
        current.on('error', (error: any): any => {
            if (currentProvider(current, epoch)) {
                deliverAfterClear((): any => state('connecting', `Voice provider connection interrupted: ${cleanProviderProse(error.message, 'connection error', 160)}`));
            }
        });
    }
    connectProvider(options.key);
    return { receive: handleClientFrame, close: (reason: any = 'ended'): any => { stopped = true; ws?.close(); close(reason); } };
}
