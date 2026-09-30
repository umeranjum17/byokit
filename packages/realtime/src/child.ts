import { createInterface } from 'node:readline';
import { toolBridge } from './tools.ts';
import { parseRealtimeClientFrame } from './frames.ts';
import type { AdapterOptions } from './adapter.ts';
import type { RealtimeHostFrame } from './frames.ts';
import type { RealtimeProviderId, RealtimeTool } from './types.ts';
import { createChatgptAdapter } from './chatgpt.ts';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let adapter: { receive(frame: ReturnType<typeof parseRealtimeClientFrame>): void; close(reason?: string): void } | undefined;
const pending = new Map<string, (output: string) => void>();
const emit = (frame: RealtimeHostFrame) => { process.stdout.write(`${JSON.stringify(frame)}\n`); };
let starting: Promise<void> | undefined;
input.on('line', line => {
  void (async () => {
    if (!starting) {
      const config = JSON.parse(line) as { engine: RealtimeProviderId; key: string; accountId?: string; tools: RealtimeTool[]; instructions: string; endpoint?: string; model?: string; voice?: string; redact?: { source: string; flags: string }[] };
      starting = (async () => {
        const handlers = Object.fromEntries(config.tools.map(tool => [tool.name, (_args: Record<string, unknown>, context: { id: string; signal: AbortSignal }) => new Promise<string>(resolve => {
          const finish = (value: string) => { context.signal.removeEventListener('abort', abort); pending.delete(context.id); resolve(value); };
          const abort = () => { process.stdout.write(`${JSON.stringify({ type: 'kit.tool.cancel', id: context.id })}\n`); finish('The request was cancelled.'); };
          pending.set(context.id, finish); context.signal.addEventListener('abort', abort, { once: true });
          process.stdout.write(`${JSON.stringify({ type: 'kit.tool', name: tool.name, args: _args, id: context.id })}\n`);
        })]));
        const bridge = toolBridge({ tools: config.tools, handlers, emit, timeoutFor: () => 300000, failure: () => 'The request could not be completed.' });
        const options: AdapterOptions = { ...config, bridge, redact: config.redact?.map(pattern => new RegExp(pattern.source, pattern.flags)) };
        if (config.engine === 'chatgpt') adapter = createChatgptAdapter({ ...options, accountId: config.accountId ?? '' });
        else {
          const module = await import(`./providers/${config.engine}.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`);
          adapter = module.createAdapter(options);
        }
      })();
      await starting; return;
    }
    await starting;
    const frame = JSON.parse(line);
    if (frame.type === 'kit.tool.result') pending.get(frame.id)?.(String(frame.output));
    else adapter?.receive(parseRealtimeClientFrame(frame));
  })().catch(() => { emit({ type: 'realtime.closed', reason: 'Voice session could not start.' }); process.exit(1); });
});
input.on('close', () => { adapter?.close(); process.exit(0); });
