import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { toolBridge } from './tools.ts';
import { parseRealtimeClientFrame } from './frames.ts';
import type { AdapterOptions, RealtimeSignalingIdentity } from './adapter.ts';
import type { RealtimeHostFrame } from './frames.ts';
import type { RealtimeProviderId, RealtimeTool } from './types.ts';
import { createChatgptAdapter } from './chatgpt.ts';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let adapter: { receive(frame: ReturnType<typeof parseRealtimeClientFrame>): void; close(reason?: string): void } | undefined;
const pending = new Map<string, { key: string; promise: Promise<string>; finish(output: string): void; cancel(): void }>();
const emit = (frame: RealtimeHostFrame) => { process.stdout.write(`${JSON.stringify(frame)}\n`); };
let starting: Promise<void> | undefined;
input.on('line', line => {
  void (async () => {
    if (!starting) {
      const config = JSON.parse(line) as { engine: RealtimeProviderId; key: string; accountId?: string; tools: RealtimeTool[]; instructions: string; endpoint?: string; model?: string; voice?: string; signalingIdentity?: RealtimeSignalingIdentity; redact?: { source: string; flags: string }[] };
      starting = (async () => {
        // The parent is the single authority for tool bounds, watchdogs, failure
        // wording and answer state. This proxy adds no competing deadline.
        const bridge: ReturnType<typeof toolBridge> = {
          run(name, args = {}, id = randomUUID(), signal) {
            if (signal?.aborted) return Promise.resolve('The request was cancelled.');
            if (!config.tools.some(tool => tool.name === name) || !args || typeof args !== 'object' || Array.isArray(args)
              || typeof id !== 'string' || id.length > 160 || Buffer.byteLength(JSON.stringify(args)) > 16000) return Promise.resolve('That request is invalid.');
            const key = JSON.stringify([name, args]);
            const prior = pending.get(id);
            if (prior) return prior.key === key ? prior.promise : Promise.resolve('Conflicting repeated request. No additional action was performed.');
            if (pending.size >= 8) return Promise.resolve('Requests are at the session limit.');
            let finish!: (output: string) => void;
            const cancel = () => { process.stdout.write(`${JSON.stringify({ type: 'kit.tool.cancel', id })}\n`); finish('The request was cancelled.'); };
            const promise = new Promise<string>(resolve => {
              finish = output => { signal?.removeEventListener('abort', cancel); pending.delete(id); resolve(output); };
            });
            pending.set(id, { key, promise, finish, cancel });
            signal?.addEventListener('abort', cancel, { once: true });
            process.stdout.write(`${JSON.stringify({ type: 'kit.tool', name, args, id })}\n`);
            return promise;
          },
          state(state, detail) { emit({ type: 'realtime.state', state, ...(detail ? { detail } : {}) }); },
          answered() {}, receive: () => false,
          close() { for (const call of [...pending.values()]) call.cancel(); },
        };
        const options: AdapterOptions = { ...config, bridge, redact: config.redact?.map(pattern => new RegExp(pattern.source, pattern.flags)) };
        if (config.engine === 'chatgpt') adapter = createChatgptAdapter({ ...options, accountId: config.accountId ?? '' });
        else {
          const module = await import(`./providers/${config.engine}.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`);
          adapter = module.createAdapter(options);
        }
        process.stdout.write(`${JSON.stringify({ type: 'kit.ready' })}\n`);
      })();
      await starting; return;
    }
    await starting;
    const frame = JSON.parse(line);
    if (frame.type === 'kit.tool.result') pending.get(frame.id)?.finish(String(frame.output));
    else adapter?.receive(parseRealtimeClientFrame(frame));
  })().catch(() => { emit({ type: 'realtime.closed', reason: 'Voice session could not start.' }); process.exit(1); });
});
input.on('close', () => { adapter?.close(); process.exit(0); });
