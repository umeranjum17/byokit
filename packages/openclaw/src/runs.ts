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

// `models.authStatus` provider rows (a bare string on older shapes). A provider is usable while any of its profiles
// is: the row's own status is its worst profile's.
type Row = { provider?: unknown; status?: unknown; profiles?: { status?: unknown }[] };
type AuthStatus = { providers?: (string | Row)[]; unavailable?: { message?: unknown } };
const USABLE = new Set(['ok', 'expiring', 'static']);
const usable = (row: string | Row): boolean => typeof row === 'string'
  || (Array.isArray(row.profiles) && row.profiles.length > 0 ? row.profiles.some((p) => USABLE.has(String(p?.status)))
    : row.status === undefined || USABLE.has(String(row.status)));

/**
 * The account a run names, `provider/model`, split for the `agent` request's per-run `provider`/`model` override.
 * Refused before any request when malformed or when it carries an `@profile` pin: the pin only reaches the engine as
 * a session preference it may rotate away from (docs/runtime-kits.md 5.8), so the kit never sends one.
 */
function account(model: string): { provider: string; model: string } {
  const at = model.indexOf('/');
  if (at <= 0 || at === model.length - 1 || /[\s@]/.test(model))
    throw new Error(`refused: "${model}" is not a provider/model reference`);
  return { provider: model.slice(0, at).toLowerCase(), model: model.slice(at + 1) }; // the engine lowercases ids
}

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
    const picked = spec.model === undefined ? undefined : account(spec.model);
    const { agentId } = await ctx.ensure(spec.member);
    const registered = spec.register !== false;
    if (registered) ctx.bridge.register({ sessionKey: spec.sessionKey, member: spec.member });
    let last = '';
    let runId = ''; // gateway events for other runs carry a real runId and never match the empty one
    let ended = false;
    // The engine flags an aborted run on its lifecycle end event; the wait receipt itself only says
    // `status: 'error', stopReason: 'rpc'` (O11), so the flag is what maps the receipt to aborted.
    let abortedByEngine = false;
    const unsubscribe = ctx.onEvent((e) => {
      if (ended || e.event !== 'agent') return;
      const p = e.payload as AgentPayload | undefined;
      if (!p || p.runId !== runId) return;
      if (p.stream === 'lifecycle' && (p.data as { phase?: string; aborted?: boolean } | undefined)?.phase === 'end'
        && (p.data as { aborted?: boolean }).aborted === true) abortedByEngine = true;
      if (p.stream === 'assistant' && typeof p.data?.text === 'string') {
        last = p.data.text;
        on?.({ type: 'text', text: p.data.text });
      } else if (p.stream === 'tool' && typeof p.data?.name === 'string') {
        // The real engine marks completion `phase: 'result'` (O11); anything but `start` ends the pair.
        on?.({ type: 'tool', name: p.data.name, phase: p.data.phase === 'start' ? 'start' : 'end' });
      }
    });
    try {
      if (picked) {
        // The picked account must be the one called: check it is signed in for this member before the run, since
        // the engine would otherwise fail the run only after admitting it. An explicit provider/model is strict on
        // the pinned engine (never another provider or model), so this check plus the override is the guarantee.
        const status = (refresh: boolean) =>
          ctx.request('models.authStatus', { agentId, ...(refresh ? { refresh: true } : {}) }) as Promise<AuthStatus>;
        let auth = await status(false);
        if (auth.unavailable) auth = await status(true); // no prepared snapshot yet: build it once
        if (auth.unavailable)
          return { ok: false, kind: 'other', message: String(auth.unavailable.message ?? 'account status unavailable') };
        const row = (auth.providers ?? []).find((e) => (typeof e === 'string' ? e : e?.provider) === picked.provider);
        if (!row || !usable(row))
          return { ok: false, kind: 'signed-out', message: `${picked.provider} is not signed in for ${spec.member}` };
      }
      const started = await ctx.request('agent', {
        agentId,
        sessionKey: spec.sessionKey,
        message: spec.message,
        idempotencyKey: randomUUID(),
        ...(picked ?? {}),
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
      if (result.stopReason === 'aborted' || (abortedByEngine && result.status !== 'ok')) return { ok: false, aborted: true };
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
