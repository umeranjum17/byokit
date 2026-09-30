import { randomUUID } from 'node:crypto';
import type { RealtimeTool } from './types.ts';
import type { RealtimeHostFrame, RealtimeClientFrame, RealtimeAppAction, RealtimeState } from './frames.ts';
export type ToolHandler = (args: Record<string, unknown>, context: { id: string; signal: AbortSignal }) => Promise<string>;
export type ToolBridgeOptions = {
  emit(frame: RealtimeHostFrame): void;
  tools: RealtimeTool[]; handlers: Record<string, ToolHandler>;
  timeoutFor?: (name: string) => number; answerTimeoutMs?: number;
  failure(name: string, error: unknown, timedOut: boolean): string;
  /** Route semantic app replies to the same bridge used by tool handlers. */
  app?: ReturnType<typeof appBridge>;
};
/** Bounded, deduplicated tool execution. Product authorization stays in handlers. */
export function toolBridge(options: ToolBridgeOptions) {
  const lifetime = new AbortController();
  const requests = new Map<string, { key: string; promise: Promise<string> }>();
  let active = 0, waiting = false;
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  const state = (value: RealtimeState, detail?: string) => options.emit({ type: 'realtime.state', state: value === 'connected' && (active > 0 || waiting) ? 'thinking' : value, ...(detail ? { detail } : {}) });
  const answered = () => { if (active) return; clearTimeout(answerTimer); waiting = false; };
  const run = (name: string, args: unknown = {}, id: string = randomUUID(), signal?: AbortSignal): Promise<string> => {
    if (lifetime.signal.aborted) return Promise.resolve('The request was cancelled.');
    let key: string;
    try { key = JSON.stringify([name, args]); } catch { return Promise.resolve('That request is invalid.'); }
    if (!options.tools.some(tool => tool.name === name) || !Object.hasOwn(options.handlers, name) || !args || typeof args !== 'object' || Array.isArray(args) || typeof id !== 'string' || id.length > 160 || Buffer.byteLength(JSON.stringify(args)) > 16000) return Promise.resolve('That request is invalid.');
    const prior = requests.get(id);
    if (prior) return prior.key === key ? prior.promise : Promise.resolve('Conflicting repeated request. No additional action was performed.');
    if (active >= 8 || requests.size >= 128) return Promise.resolve('Requests are at the session limit.');
    const controller = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    active++; clearTimeout(answerTimer); waiting = false; state('thinking');
    const promise = (async () => {
      let abort = () => {};
      const timer = setTimeout(() => controller.abort(), options.timeoutFor?.(name) ?? 20000);
      try {
        const aborted = new Promise<never>((_, reject) => { abort = () => reject(new Error('cancelled')); combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort(); });
        const operation = Promise.resolve().then(() => { combined.throwIfAborted(); return options.handlers[name](args as Record<string, unknown>, { id, signal: combined }); });
        return String(await Promise.race([operation, aborted])).slice(0, 8000);
      } catch (error) { return options.failure(name, error, controller.signal.aborted).slice(0, 8000); }
      finally {
        clearTimeout(timer); combined.removeEventListener('abort', abort); active--;
        if (!combined.aborted && !lifetime.signal.aborted) {
          waiting = true; clearTimeout(answerTimer);
          answerTimer = setTimeout(() => { waiting = false; state('connected', 'The voice provider did not finish answering the request.'); }, options.answerTimeoutMs ?? 20000);
        }
      }
    })();
    requests.set(id, { key, promise }); return promise;
  };
  return { run, state, answered, receive: (frame: RealtimeClientFrame) => options.app?.receive(frame) ?? false, close() { lifetime.abort(); options.app?.close(); clearTimeout(answerTimer); waiting = false; } };
}

/** Structured requests use the app's allowlisted tools; prose uses its planner. */
export function delegationHandler(options: {
  bridge: ReturnType<typeof toolBridge>;
  plan?: (request: string, context: Parameters<ToolHandler>[1]) => Promise<string>;
}): ToolHandler {
  return async (args, context) => {
    context.signal.throwIfAborted();
    const request = args.request;
    if (typeof request !== 'string' || !request.trim() || Buffer.byteLength(request) > 16000) return 'That delegated request is invalid.';
    let structured: unknown;
    try { structured = JSON.parse(request); }
    catch {
      // JSON-looking input is never reinterpreted as permission to plan an action.
      if (/^[\s]*[\[{]/.test(request)) return 'That delegated request is invalid.';
      return options.plan ? options.plan(request, context) : 'That delegation needs an app planner.';
    }
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return 'That delegated request is invalid.';
    const call = structured as Record<string, unknown>;
    if (typeof call.name !== 'string' || !call.name.trim() || call.name === 'delegate'
      || Object.keys(call).some(key => key !== 'name' && key !== 'arguments')) return 'That delegated request is invalid.';
    // Arguments, including named targets, stay intact. The app validates and authorizes them.
    return options.bridge.run(call.name, call.arguments === undefined ? {} : call.arguments, context.id, context.signal);
  };
}
export function appBridge(emit: (frame: RealtimeHostFrame) => void | boolean, options: { timeoutMs?: number; maxPending?: number } = {}) {
  const pending = new Map<string, (text: string) => void>();
  return {
    run(action: RealtimeAppAction, target?: string, signal?: AbortSignal): Promise<string> {
      if (signal?.aborted) return Promise.resolve('The app request was cancelled.');
      if (!['view', 'navigate', 'activate'].includes(action) || action !== 'view' && (!target?.trim() || Buffer.byteLength(target) > 160)) return Promise.resolve('That app request is invalid.');
      if (pending.size >= (options.maxPending ?? 8)) return Promise.resolve('The app is busy.');
      return new Promise(resolve => {
        const requestId = randomUUID();
        const finish = (text: string) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(requestId); resolve(text); };
        const abort = () => finish('The app request was cancelled.');
        const timer = setTimeout(() => finish('The app did not answer that request.'), options.timeoutMs ?? 15000);
        pending.set(requestId, finish); signal?.addEventListener('abort', abort, { once: true });
        try { if (emit({ type: 'realtime.app.request', requestId, action, ...(action === 'view' ? {} : { target }) }) === false) finish('The app could not receive that request.'); }
        catch { finish('The app is unavailable.'); }
      });
    },
    receive(frame: RealtimeClientFrame) { if (frame.type !== 'realtime.app.result') return false; pending.get(frame.requestId)?.(frame.ok ? frame.text.slice(0, 4000) : 'The app could not complete that request.'); return true; },
    close() { for (const finish of pending.values()) finish('The app request was cancelled.'); },
  };
}
