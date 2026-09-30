import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseRealtimeClientFrame, parseRealtimeHostFrame } from './frames.ts';
import type { RealtimeClientFrame, RealtimeHostFrame } from './frames.ts';
import type { RealtimeAuth, RealtimeConfig, RealtimeProviderId, RealtimeUsage } from './types.ts';
import { RealtimeError } from './types.ts';
import { cleanProse } from './prose.ts';
import { toolBridge } from './tools.ts';
import { realtimeAuthCheck } from './auth.ts';
import type { RealtimeAuthCheckOptions } from './auth.ts';
export { toolBridge, appBridge, delegationHandler } from './tools.ts';
export { realtimeAuthCheck } from './auth.ts';
export type { RealtimeAuthCheckOptions, RealtimeAuthStatus } from './auth.ts';
export type { ToolHandler, ToolBridgeOptions } from './tools.ts';
export type RealtimeEngineOptions = RealtimeConfig & {
  engine: RealtimeProviderId; auth: RealtimeAuth;
  bridge: ReturnType<typeof toolBridge>;
  emit(frame: RealtimeHostFrame): void;
  /** Only loopback overrides are accepted, for fake-provider flows. */
  endpoint?: string; redact?: RegExp[];
  onUsage?(usage: RealtimeUsage): void;
  /** Optional read-only advisory check; never awaited before starting the provider. */
  authCheck?: RealtimeAuthCheckOptions;
};
/** Provider sockets and SDP signaling run in a kit-owned child, never in the app process. */
export function realtimeEngine(options: RealtimeEngineOptions) {
  if (!['chatgpt', 'openai', 'gemini', 'xai'].includes(options.engine)) throw new RealtimeError('unsupported');
  if (options.endpoint && !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(options.endpoint).hostname)) throw new RealtimeError('unsupported');
  if ((options.engine === 'chatgpt') !== (options.auth.kind === 'plan')) throw new RealtimeError('unsupported');
  let stopped = false, emittedClose = false;
  const lifetime = new AbortController();
  const authCheck = options.authCheck ? realtimeAuthCheck(options.authCheck) : undefined;
  const start = Date.now();
  let child: ReturnType<typeof spawn> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedBytes = 0;
  const pending: string[] = [];
  const toolCalls = new Map<string, AbortController>();
  const secrets: string[] = [];
  const usage: RealtimeUsage = { seconds: 0, basis: options.engine === 'chatgpt' ? 'subscription' : options.engine === 'xai' ? 'minutes' : 'tokens' };
  const safe = (value: string) => { let result = value; for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[hidden]'); return cleanProse(result, 'Voice ended.', 500, options.redact); };
  const emit = (frame: RealtimeHostFrame) => {
    if (frame.type === 'realtime.state' && frame.detail) frame = { ...frame, detail: safe(frame.detail) };
    if (frame.type === 'realtime.closed' && frame.reason) frame = { ...frame, reason: safe(frame.reason) };
    if (frame.type === 'realtime.transcript') frame = { ...frame, text: safe(frame.text) };
    // Inspect every outbound string, including data-channel payloads, for exact credentials.
    const serialized = JSON.stringify(frame);
    if (secrets.some(secret => secret && serialized.includes(secret))) {
      if (frame.type === 'realtime.webrtc.answer') { finish('Voice answer included private credentials.'); return; }
      for (const secret of secrets) if (secret) frame = JSON.parse(JSON.stringify(frame).replaceAll(secret, '[hidden]'));
    }
    options.emit(frame);
  };
  const finish = (reason?: string, retryable = false) => {
    if (emittedClose) return; emittedClose = true; stopped = true; lifetime.abort(); authCheck?.close(); options.bridge.close();
    usage.seconds = (Date.now() - start) / 1000;
    options.onUsage?.({ ...usage }); emit({ type: 'realtime.usage', usage: { ...usage } }); emit({ type: 'realtime.closed', ...(retryable ? { retryable: true } : {}), ...(reason ? { reason: safe(reason) } : {}) });
    if (child && child.exitCode === null) { child.kill('SIGTERM'); killTimer = setTimeout(() => child?.kill('SIGKILL'), 1000); killTimer.unref(); }
  };
  const send = (line: string): boolean => {
    if (!child?.stdin || stopped || child.stdin.destroyed || child.stdin.writableLength + Buffer.byteLength(line) > 512 * 1024) return false;
    child.stdin.write(line); return true;
  };
  const ready = (async () => {
    const credential = options.auth.kind === 'key' ? { access: options.auth.key, accountId: '' } : await options.auth.access(lifetime.signal);
    if (stopped) return;
    secrets.push(credential.access);
    const entry = new URL(`./child.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
    child = spawn(process.execPath, [fileURLToPath(entry)], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.on('error', () => finish('Voice input failed.'));
    child.on('error', () => finish('Voice could not start.'));
    child.on('exit', () => { clearTimeout(killTimer); finish('Voice provider disconnected.'); });
    // Never forward stderr: providers may include credentials in URLs or errors.
    child.stderr!.resume();
    let lineBytes = 0;
    const startupTimer = setTimeout(() => finish('Voice setup timed out.'), 20000);
    child.once('exit', () => clearTimeout(startupTimer));
    child.stdout!.on('data', (chunk: Buffer) => { for (const byte of chunk) { if (byte === 10) lineBytes = 0; else if (++lineBytes > 128 * 1024) { finish('Voice frame exceeded its limit.'); break; } } });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => {
      if (stopped) return;
      try {
        const raw = JSON.parse(line);
        if (raw.type === 'kit.tool.cancel') { toolCalls.get(raw.id)?.abort(); return; }
        if (raw.type === 'kit.tool') {
          const controller = toolCalls.get(raw.id) ?? new AbortController(); toolCalls.set(raw.id, controller);
          void options.bridge.run(raw.name, raw.args, raw.id, AbortSignal.any([lifetime.signal, controller.signal])).then(output => { send(`${JSON.stringify({ type: 'kit.tool.result', id: raw.id, output })}\n`); }).catch(() => finish('Voice tool failed.')).finally(() => toolCalls.delete(raw.id)); return;
        }
        const frame = parseRealtimeHostFrame(raw);
        if (frame.type === 'realtime.ready' || frame.type === 'realtime.webrtc.start') clearTimeout(startupTimer);
        if (frame.type === 'realtime.closed') { finish(frame.reason, frame.retryable); return; }
        if (frame.type === 'realtime.usage') {
          for (const key of ['inputTokens', 'outputTokens', 'audioInTokens', 'audioOutTokens', 'cachedTokens'] as const) if (frame.usage[key] !== undefined) usage[key] = (usage[key] ?? 0) + frame.usage[key]!;
          usage.seconds = (Date.now() - start) / 1000; emit({ type: 'realtime.usage', usage: { ...usage } }); return;
        }
        if (frame.type === 'realtime.transcript' && frame.role === 'agent') options.bridge.answered();
        emit(frame);
      } catch { finish('Voice provider sent an invalid frame.'); }
    });
    send(`${JSON.stringify({ engine: options.engine, key: credential.access, accountId: credential.accountId, instructions: options.instructions ?? '', tools: options.tools ?? [], model: options.model, voice: options.voice, endpoint: options.endpoint, redact: options.redact?.map(pattern => ({ source: pattern.source, flags: pattern.flags })) })}\n`);
    for (const line of pending) if (!send(line)) { finish('Voice input overflowed.'); break; } pending.length = 0; queuedBytes = 0;
  })().catch(() => finish('Voice sign-in is unavailable.'));
  return {
    ready, usage,
    receive(raw: RealtimeClientFrame): boolean {
      if (stopped) return false;
      const frame = parseRealtimeClientFrame(raw);
      if (options.bridge.receive(frame)) return true;
      const line = `${JSON.stringify(frame)}\n`;
      if (!child) { const bytes = Buffer.byteLength(line); if (queuedBytes + bytes > 128 * 1024) { finish('Voice input overflowed.'); return false; } pending.push(line); queuedBytes += bytes; return true; }
      return send(line);
    },
    close(reason?: string) { finish(reason); },
  };
}
