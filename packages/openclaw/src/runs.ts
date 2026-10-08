// Runs: one Gateway run per spec, streamed through typed events, ending in a classified RunEnd (5.8, O8).
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Bridge } from './bridge.ts';
import { authStatus } from './auth-status.ts';
import { outputSchema, type OutputSchema, type SchemaOutput } from './output.ts';
import { words } from './words.ts';
import { classify } from './classify.ts';
import type { GatewayTransport, Member, PlanWindow, RunEnd, RunEvent, RunSpec, RunUsage } from './types.ts';

// The gateway gives up on a silent run after an hour; we wait ten minutes longer for the reply frame itself.
const WAIT_MS = 3_600_000;
const WAIT_CLIENT_MS = 3_610_000;
// The `agent` request's final frame lands with the run's end; a run already over waits no longer than this for it.
const FINAL_GRACE_MS = 5_000;
const STATUS_MS = 5_000;

// The slice of the gateway's `agent` event payload a run streams (5.8); the rest passes to onEvent-less callers.
type AgentPayload = { runId: string; stream: string; data?: {
  text?: unknown; name?: unknown; phase?: unknown; toolCallId?: unknown; args?: unknown; result?: unknown; isError?: unknown; progressTokens?: unknown;
} };

// `models.authStatus` provider rows (a bare string on older shapes). A provider is usable while any of its profiles
// is: the row's own status is its worst profile's.
type Row = { provider?: unknown; status?: unknown; profiles?: { status?: unknown }[]; usage?: unknown };
type AuthStatus = { providers?: (string | Row)[]; unavailable?: { message?: unknown } };
const USABLE = new Set(['ok', 'expiring', 'static']);
const usable = (row: string | Row): boolean => typeof row === 'string'
  || (Array.isArray(row.profiles) && row.profiles.length > 0 ? row.profiles.some((p) => USABLE.has(String(p?.status)))
    : row.status === undefined || USABLE.has(String(row.status)));

/**
 * The providers a `models.authStatus` answer shows usable (the rule a picked account is checked by), lowercased and
 * unique; undefined while the engine has no prepared status (unknown, not none).
 */
export function signedInProviders(status: unknown): string[] | undefined {
  const auth = (status ?? {}) as AuthStatus;
  if (auth.unavailable || !Array.isArray(auth.providers)) return undefined;
  const names = auth.providers.filter((row) => row && usable(row))
    .map((row) => (typeof row === 'string' ? row : row.provider))
    .filter((name): name is string => typeof name === 'string' && name !== '');
  return [...new Set(names.map((name) => name.toLowerCase()))];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * The run's usage off the `agent` final frame's `result.meta.agentMeta` (pin: `usage` summed over the run, zero
 * buckets and all-zero usage omitted; `costUsd` only when the engine has a price). Undefined when it reports none.
 */
function usageOf(agentMeta: Record<string, unknown>): RunUsage | undefined {
  const u = isRecord(agentMeta.usage) ? agentMeta.usage : {};
  const usage: RunUsage = {};
  for (const [from, to] of [['input', 'input'], ['output', 'output'], ['cacheRead', 'cacheRead'], ['cacheWrite', 'cacheWrite'],
    ['reasoningTokens', 'reasoning'], ['total', 'total']] as const) if (count(u[from])) usage[to] = u[from];
  if (count(agentMeta.costUsd)) usage.costUsd = agentMeta.costUsd;
  return Object.keys(usage).length ? usage : undefined;
}

/** The provider's quota windows from a `models.authStatus` row's `usage`, only when it lists at least one. */
function planOf(provider: string, row: Row | undefined): PlanWindow | undefined {
  const usage = row?.usage;
  if (!isRecord(usage) || !Array.isArray(usage.windows)) return undefined;
  const windows = usage.windows.filter((w): w is { label: string; usedPercent: number; resetAt?: unknown } =>
    isRecord(w) && typeof w.label === 'string' && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent))
    .map((w) => ({ label: w.label, usedPercent: w.usedPercent, ...(count(w.resetAt) ? { resetAt: w.resetAt } : {}) }));
  if (!windows.length) return undefined;
  return { provider, ...(typeof usage.plan === 'string' ? { plan: usage.plan } : {}), windows };
}

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
  authStatus?: (agentId: string, refresh: boolean, native: boolean) => ReturnType<typeof authStatus>;
  invalidateAuth?: () => void;
  onEvent: GatewayTransport['onEvent'];
  ensure(member: Member): Promise<{ agentId: string }>;
  bridge: Pick<Bridge, 'register'>;
  tools: ReadonlySet<string>; // KitOptions.tools names, the only names a run's subset may carry
}): {
  run<const S extends OutputSchema | undefined = undefined>(spec: RunSpec<S>, on?: (e: RunEvent) => void, keyAgent?: string, preparedOutput?: ReturnType<typeof outputSchema>): Promise<RunEnd<SchemaOutput<S>>>;
  steer(k: string, t: string): Promise<void>;
  abort(k: string): Promise<void>;
} {
  // The plan window the engine last read for the run's provider: `models.authStatus` answers from its cache without
  // blocking. Nothing reported, or no answer in time, is no window.
  const planWindowOf = async (agentId: string, provider: string): Promise<PlanWindow | undefined> => {
    try {
      const auth = await ctx.request('models.authStatus', { agentId }, { timeoutMs: STATUS_MS }) as AuthStatus;
      const row = (auth.providers ?? []).find((e): e is Row => typeof e !== 'string' && e?.provider === provider);
      return planOf(provider, row);
    } catch {
      return undefined;
    }
  };
  const failure = (message: string) => {
    const classified = classify(message);
    if (classified.kind === 'signed-out') ctx.invalidateAuth?.();
    return { ok: false as const, ...classified, message };
  };
  const run = async <const S extends OutputSchema | undefined = undefined>(spec: RunSpec<S>, on?: (e: RunEvent) => void, keyAgent?: string, preparedOutput?: ReturnType<typeof outputSchema>): Promise<RunEnd<SchemaOutput<S>>> => {
    // Member boundary first: a member never speaks in another member's session, refused before any request.
    if (!spec.sessionKey.startsWith(`agent:${spec.member}:`))
      throw new Error(`refused: "${spec.sessionKey}" is not a session of member "${spec.member}"`);
    // Same validation as the pin's NonEmptyString; preserve the caller's bytes (including whitespace).
    if (spec.idempotencyKey !== undefined && (typeof spec.idempotencyKey !== 'string' || !spec.idempotencyKey.length))
      throw new Error('refused: idempotencyKey must be a non-empty string');
    const idempotencyKey = spec.idempotencyKey ?? randomUUID();
    const output = preparedOutput ?? (spec.schema === undefined ? undefined : outputSchema(spec.schema));
    const system = [spec.system, output?.prompt].filter(Boolean).join('\n\n');
    const picked = spec.model === undefined ? undefined : account(spec.model);
    for (const tool of spec.tools ?? [])
      if (!ctx.tools.has(tool)) throw new Error(`refused: "${tool}" is not one of this kit's tools`);
    const agentId = keyAgent ?? (await ctx.ensure(spec.member)).agentId;
    const sessionKey = keyAgent ? `agent:${keyAgent}:${spec.sessionKey.slice(`agent:${spec.member}:`.length)}` : spec.sessionKey;
    const release = spec.register !== false ? ctx.bridge.register({ sessionKey, member: spec.member }, spec.tools, idempotencyKey) : undefined;
    let last: string | undefined;
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
      if (p.stream === 'thinking' && count(p.data?.progressTokens)) {
        on?.({ type: 'thinking', tokens: p.data.progressTokens });
      } else if (p.stream === 'assistant' && typeof p.data?.text === 'string') {
        last = p.data.text;
        on?.({ type: 'text', text: p.data.text });
      } else if (p.stream === 'tool' && typeof p.data?.name === 'string') {
        // The real engine marks completion `phase: 'result'` (O11). Its `update`, `input_delta` and `review` phases
        // are progress inside the pair, not its end.
        const d = p.data;
        const end = d.phase === 'result' || d.phase === 'end';
        if (d.phase !== 'start' && !end) return;
        on?.({ type: 'tool', name: d.name as string, phase: end ? 'end' : 'start',
          ...(typeof d.toolCallId === 'string' ? { id: d.toolCallId } : {}),
          ...(!end && isRecord(d.args) ? { input: d.args } : {}),
          ...(end && d.result !== undefined ? { output: d.result } : {}),
          ...(end && typeof d.isError === 'boolean' ? { error: d.isError } : {}) });
      }
    });
    try {
      if (picked) {
        // The picked account must be the one called: check it is signed in for this member before the run, since
        // the engine would otherwise fail the run only after admitting it. An explicit provider/model is strict on
        // the pinned engine (never another provider or model), so this check plus the override is the guarantee.
        const status = (refresh: boolean) =>
          ctx.authStatus ? ctx.authStatus(agentId, refresh, picked.provider === 'claude-cli')
            : authStatus(ctx.request, agentId, refresh, picked.provider === 'claude-cli');
        let auth = await status(false);
        if (auth.unavailable) auth = await status(true); // no prepared snapshot yet: build it once
        if (auth.unavailable)
          return { ok: false, kind: 'other', message: String(auth.unavailable.message ?? 'account status unavailable') };
        const row = (auth.providers ?? []).find((e) => (typeof e === 'string' ? e : e?.provider) === picked.provider);
        if (!row || !usable(row))
          return { ok: false, kind: 'signed-out', message: `${picked.provider} is not signed in for ${spec.member}` };
      }
      // One `agent` request: its interim `accepted` frame names the run, its final frame (after the run) carries the
      // run's usage. The wait below still decides how the run ended.
      let accepted!: (payload: unknown) => void;
      const ack = new Promise<unknown>((resolve) => { accepted = resolve; });
      // The run id is taken as the accepted frame lands, so no event read after it is missed.
      const onAccepted = (payload: unknown): void => {
        if (isRecord(payload) && typeof payload.runId === 'string') {
          const first = !runId;
          runId = payload.runId;
          if (first && payload.status === 'accepted') on?.({ type: 'started' });
        }
        accepted(payload);
      };
      const final = ctx.request('agent', {
        agentId,
        sessionKey,
        message: spec.message,
        idempotencyKey,
        ...(picked ?? {}),
        ...(system ? { extraSystemPrompt: system } : {}),
        ...(spec.images ? { attachments: spec.images.map((image) => ({ mimeType: image.mimeType, content: image.data })) } : {}),
        ...(spec.thinking ? { thinking: spec.thinking } : {}),
      }, { expectFinal: true, timeoutMs: WAIT_CLIENT_MS, onAccepted });
      final.catch(() => {}); // a late failure is the wait's to report
      const started = await Promise.race([ack, final]) as { runId: string };
      runId = started.runId;
      const result = await ctx.request('agent.wait', { runId, timeoutMs: WAIT_MS }, { timeoutMs: WAIT_CLIENT_MS }) as {
        status?: string; stopReason?: string; terminalReply?: { disposition?: string; text?: string }; error?: unknown; message?: unknown;
      };
      if (result.status === 'ok') {
        // A cached `in_flight` replay has no final subscription. Keep the existing wait/stream fallback:
        // re-sending `agent` to fetch its final could dispatch again if the bounded cache was evicted.
        const done = await Promise.race([final.catch(() => undefined), delay(FINAL_GRACE_MS, undefined, { ref: false })]);
        ended = true; // no later stream event may supersede the final callback
        const frame = isRecord(done) && isRecord(done.result) ? done.result : {};
        const payloadText = Array.isArray(frame.payloads)
          ? frame.payloads.filter((p): p is Record<string, unknown> & { text: string } => isRecord(p) && typeof p.text === 'string')
            .map((p) => p.text) : [];
        // The pin's terminal snapshot is capped display evidence, not the complete generated answer.
        // Its silent/empty disposition still controls visibility, even after transient streamed text.
        const terminal = result.terminalReply;
        const text = terminal?.disposition === 'silent' || terminal?.disposition === 'empty' ? ''
          : payloadText.length ? payloadText.join('\n\n')
          : last ?? (typeof terminal?.text === 'string' ? terminal.text : '');
        on?.({ type: 'text', text }); // the final cumulative text (unvalidated)
        const parsed = output?.parse(text);
        if (output && !parsed) return { ok: false, kind: 'output', message: words('member.output') };
        const meta = isRecord(frame.meta) ? frame.meta : {};
        const agentMeta = isRecord(meta.agentMeta) ? meta.agentMeta : {};
        const usage = usageOf(agentMeta);
        const planWindow = typeof agentMeta.provider === 'string'
          ? await planWindowOf(agentId, agentMeta.provider.toLowerCase()) : undefined;
        return { ok: true, text, ...(parsed ? { data: parsed.data as SchemaOutput<S> } : {}), ...(usage ? { usage } : {}), ...(planWindow ? { planWindow } : {}) };
      }
      if (result.stopReason === 'aborted' || (abortedByEngine && result.status !== 'ok')) return { ok: false, aborted: true };
      const message = typeof result.error === 'string' ? result.error
        : typeof result.message === 'string' ? result.message : '';
      return failure(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(message);
    } finally {
      ended = true;
      unsubscribe();
      release?.();
    }
  };
  return {
    run,
    steer: (k, t) => ctx.request('sessions.steer', { sessionKey: k, message: t }) as Promise<void>,
    abort: (k) => ctx.request('chat.abort', { sessionKey: k }) as Promise<void>,
  };
}
