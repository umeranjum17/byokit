// Runs: one Gateway run per spec, streamed through typed events, ending in a classified RunEnd (5.8, O8).
import { randomUUID } from 'node:crypto';
import type { Bridge } from './bridge.ts';
import { classify } from './classify.ts';
import type { GatewayTransport, Member, RunEnd, RunEvent, RunSpec } from './types.ts';

// The gateway gives up on a silent run after an hour; we wait ten minutes longer for the reply frame itself.
const WAIT_MS = 3_600_000;
const WAIT_CLIENT_MS = 3_610_000;

// The slice of the gateway's `agent` event payload a run streams (5.8); the rest passes to onEvent-less callers.
type AgentPayload = { runId: string; stream: string; data?: { text?: unknown; name?: unknown; phase?: unknown } };

export function createRuns(ctx: {
  request: GatewayTransport['request'];
  onEvent: GatewayTransport['onEvent'];
  ensure(member: Member): Promise<{ agentId: string }>;
  bridge: Pick<Bridge, 'register' | 'unregister'>;
}): {
  run(spec: RunSpec, on?: (e: RunEvent) => void): Promise<RunEnd>;
  steer(k: string, t: string): Promise<void>;
  abort(k: string): Promise<void>;
} {
  const run = async (spec: RunSpec, on?: (e: RunEvent) => void): Promise<RunEnd> => {
    // Member boundary first: a member never speaks in another member's session, refused before any request.
    if (!spec.sessionKey.startsWith(`agent:${spec.member}:`))
      throw new Error(`refused: "${spec.sessionKey}" is not a session of member "${spec.member}"`);
    const { agentId } = await ctx.ensure(spec.member);
    const registered = spec.register !== false;
    if (registered) ctx.bridge.register({ sessionKey: spec.sessionKey, member: spec.member });
    let last = '';
    let runId = ''; // gateway events for other runs carry a real runId and never match the empty one
    let ended = false;
    const unsubscribe = ctx.onEvent((e) => {
      if (ended || e.event !== 'agent') return;
      const p = e.payload as AgentPayload | undefined;
      if (!p || p.runId !== runId) return;
      if (p.stream === 'assistant' && typeof p.data?.text === 'string') {
        last = p.data.text;
        on?.({ type: 'text', text: p.data.text });
      } else if (p.stream === 'tool' && typeof p.data?.name === 'string') {
        on?.({ type: 'tool', name: p.data.name, phase: p.data.phase === 'end' ? 'end' : 'start' });
      }
    });
    try {
      const started = await ctx.request('agent', {
        agentId,
        sessionKey: spec.sessionKey,
        message: spec.message,
        idempotencyKey: randomUUID(),
        ...(spec.system ? { extraSystemPrompt: spec.system } : {}),
        ...(spec.images ? { attachments: spec.images.map((image) => ({ mimeType: image.mimeType, content: image.data })) } : {}),
        ...(spec.thinking ? { thinking: spec.thinking } : {}),
      }) as { runId: string };
      runId = started.runId;
      const result = await ctx.request('agent.wait', { runId, timeoutMs: WAIT_MS }, { timeoutMs: WAIT_CLIENT_MS }) as {
        status?: string; stopReason?: string; terminalReply?: { text?: string }; error?: unknown; message?: unknown;
      };
      if (result.status === 'ok') {
        const text = typeof result.terminalReply?.text === 'string' ? result.terminalReply.text : last;
        on?.({ type: 'text', text }); // the final cumulative text
        return { ok: true, text };
      }
      if (result.stopReason === 'aborted') return { ok: false, aborted: true };
      const message = typeof result.error === 'string' ? result.error
        : typeof result.message === 'string' ? result.message : '';
      return { ok: false, ...classify(message), message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, ...classify(message), message };
    } finally {
      ended = true;
      unsubscribe();
      if (registered) ctx.bridge.unregister(spec.sessionKey);
    }
  };
  return {
    run,
    steer: (k, t) => ctx.request('sessions.steer', { sessionKey: k, message: t }) as Promise<void>,
    abort: (k) => ctx.request('chat.abort', { sessionKey: k }) as Promise<void>,
  };
}
