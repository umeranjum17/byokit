// Runs: one Gateway run per spec, streamed through typed events, ending in a classified RunEnd (5.8, O8).
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Bridge } from './bridge.ts';
import { HELPER_TAIL, HelperError, type createHelpers } from './helpers.ts';
import type { Delegations } from './delegations.ts';
import type { createAccounts } from './accounts.ts';
import type { createLocks } from './locks.ts';
import { authStatus } from './auth-status.ts';
import { outputSchema, type OutputSchema, type SchemaOutput } from './output.ts';
import { words } from './words.ts';
import { classify } from './classify.ts';
import { providerOf } from './pick.ts';
import { engineId } from './accounts.ts';
import { catalogModelOf, clampThinking, levelsOf, type CatalogModel } from './thinking.ts';
import type { AccountPick, CliLoginCause, GatewayTransport, Member, PlanWindow, RunEnd, RunEvent, RunFrame, RunSpec, RunUsage, ThinkingReport } from './types.ts';

// The gateway gives up on a silent run after an hour; we wait ten minutes longer for the reply frame itself.
const WAIT_MS = 3_600_000;
const WAIT_CLIENT_MS = 3_610_000;
// The `agent` request's final frame lands with the run's end; a run already over waits no longer than this for it.
const FINAL_GRACE_MS = 5_000;
const STATUS_MS = 5_000;
// A resting end whose message names no time rests the account this long (5.15 Runs step 7).
const REST_MS = 300_000;

// The slice of the gateway's `agent` event payload a run streams (5.8); the rest passes to onEvent-less callers.
type AgentPayload = { runId: string; stream: string; data?: {
  text?: unknown; name?: unknown; phase?: unknown; toolCallId?: unknown; args?: unknown; result?: unknown; isError?: unknown; progressTokens?: unknown;
} };

// `models.authStatus` provider rows (a bare string on older shapes). A provider is usable while any of its profiles
// is: the row's own status is its worst profile's.
type Row = { provider?: unknown; status?: unknown; profiles?: { status?: unknown }[]; usage?: unknown };
type AuthStatus = { providers?: (string | Row)[]; unavailable?: { message?: unknown }; unknown?: string[] };
export const USABLE = new Set(['ok', 'expiring', 'static']);
const usable = (row: string | Row): boolean => typeof row === 'string'
  || (Array.isArray(row.profiles) && row.profiles.length > 0 ? row.profiles.some((p) => USABLE.has(String(p?.status)))
    : row.status === undefined || USABLE.has(String(row.status)));

/**
 * The providers a `models.authStatus` answer shows usable (the rule a picked account is checked by), lowercased and
 * unique; undefined while the engine has no prepared status (unknown, not none).
 */
export function signedInProviders(status: unknown): string[] | undefined {
  const auth = (status ?? {}) as AuthStatus;
  return auth.unknown?.length ? undefined : usableProviders(auth);
}

/** The usable providers an answer does list, even when another provider's sign-in could not be checked (`unknown`). */
export function usableProviders(status: unknown): string[] | undefined {
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
  const provider = providerOf(model);
  if (provider === undefined) throw new Error(`refused: "${model}" is not a provider/model reference`);
  return { provider, model: model.slice(model.indexOf('/') + 1) }; // the engine lowercases ids
}

type Emission<E = RunEvent> = E extends RunEvent ? Omit<E, 'seq'> : never;
type Journal = { member: Member; frames: Exclude<RunFrame, { type: 'truncated' }>[]; done: boolean; wake: Set<() => void> };

/** Live-kit only: bounded history, with readers pulling by cursor rather than growing per-reader queues. */
export class RunReplay {
  private readonly runs = new Map<string, Journal>();
  begin(member: Member, id: string): Journal | undefined {
    if (this.runs.has(id)) return undefined; // engine-cache retry must not replace the original stream
    const row: Journal = { member, frames: [], done: false, wake: new Set() };
    this.runs.set(id, row);
    return row;
  }
  push(row: Journal | undefined, frame: Exclude<RunFrame, { type: 'truncated' }>): void {
    if (!row) return;
    row.frames.push(frame);
    if (row.frames.length > 32) row.frames.shift();
    row.done = frame.type === 'end';
    for (const wake of row.wake) wake();
    if (row.done) {
      const completed = [...this.runs].filter(([, r]) => r.done);
      for (const [id] of completed.slice(0, -128)) this.runs.delete(id);
    }
  }
  clear(): void {
    for (const row of this.runs.values()) for (const wake of row.wake) wake();
    this.runs.clear();
  }
  attach(member: Member, id: string, fromSeq: number, signal: AbortSignal): AsyncIterable<RunFrame> {
    const row = this.runs.get(id);
    if (row && row.member !== member) throw new Error('foreign run');
    const runs = this.runs;
    return (async function* () {
      let cursor = fromSeq;
      while (!signal.aborted) {
        if (!row || runs.get(id) !== row) { yield { type: 'truncated', reason: 'not-found' } as const; return; }
        const firstSeq = row.frames[0]?.seq ?? 1;
        const lastSeq = row.frames.at(-1)?.seq ?? 0;
        if (cursor < firstSeq - 1 || cursor > lastSeq) {
          yield { type: 'truncated', reason: 'truncated', firstSeq } as const; return;
        }
        const next = row.frames.find(f => f.seq > cursor);
        if (next) { cursor = next.seq; yield next; if (next.type === 'end') return; continue; }
        if (row.done) return;
        await new Promise<void>(resolve => {
          const wake = () => { row.wake.delete(wake); signal.removeEventListener('abort', wake); resolve(); };
          row.wake.add(wake); signal.addEventListener('abort', wake, { once: true });
        });
      }
    })();
  }
}

export function createRuns(ctx: {
  replay?: RunReplay;
  request: GatewayTransport['request'];
  authStatus?: (agentId: string, refresh: boolean, native: boolean) => ReturnType<typeof authStatus>;
  invalidateAuth?: () => void;
  claudeLogin?: () => CliLoginCause;
  onEvent: GatewayTransport['onEvent'];
  ensure(member: Member): Promise<{ agentId: string }>;
  bridge: Pick<Bridge, 'register'>;
  delegations?: Delegations;
  helpers?: Pick<ReturnType<typeof createHelpers>, 'resolve'>;
  tools: ReadonlySet<string>; // KitOptions.tools names, the only names a run's subset may carry
  accounts?: Pick<ReturnType<typeof createAccounts>, 'bind' | 'keyRefusal' | 'pick' | 'rest'>; // 5.15: account runs
  locks?: ReturnType<typeof createLocks>;
  routes: Map<string, { session: string }>; // the caller's session key -> the account session its live run uses; steer and abort follow it
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
  // A signed-out claude-cli run names where its Claude Code login is missing (`cause`).
  const cause = (provider: string | undefined) => provider === 'claude-cli' && ctx.claudeLogin ? { cause: ctx.claudeLogin() } : {};
  const signedOut = (provider: string, message: string) => ({ ok: false as const, kind: 'signed-out' as const, message, ...cause(provider) });
  const failure = (message: string, provider?: string) => {
    const classified = classify(message);
    if (classified.kind === 'signed-out') ctx.invalidateAuth?.();
    return { ok: false as const, ...classified, message, ...classified.kind === 'signed-out' ? cause(provider) : {} };
  };
  const execute = async <const S extends OutputSchema | undefined = undefined>(spec: RunSpec<S>, on?: (e: Emission) => void, keyAgent?: string, preparedOutput?: ReturnType<typeof outputSchema>): Promise<RunEnd<SchemaOutput<S>>> => {
    // Member boundary first: a member never speaks in another member's session, refused before any request. A key
    // of one of the member's account agents is the member's too; binding below checks the index names it.
    if (!spec.sessionKey.startsWith(`agent:${spec.member}:`) && !(ctx.accounts && !keyAgent && spec.sessionKey.startsWith(`agent:${spec.member}--`)))
      throw new Error(`refused: "${spec.sessionKey}" is not a session of member "${spec.member}"`);
    const tail = spec.sessionKey.slice(spec.sessionKey.indexOf(':', 'agent:'.length) + 1);
    // A helper (5.8.3) speaks only under `agent:<member>:h-<helper>:`, with its persona as the whole system text, and
    // only a run naming that helper speaks there. Refused before any request.
    if (spec.helper !== undefined && (!ctx.helpers || keyAgent || spec.system !== undefined))
      throw new HelperError('invalid', `refused: helper ${String(spec.helper)} runs on its own account with its own persona`);
    const helper = spec.helper === undefined ? undefined : ctx.helpers!.resolve(spec.member, spec.helper);
    if (helper ? !spec.sessionKey.startsWith(`agent:${spec.member}:h-${spec.helper}:`) : HELPER_TAIL.test(tail))
      throw new HelperError('session', `refused: "${spec.sessionKey}" is not a session of ${helper ? `helper "${spec.helper}"` : 'this run'}`);
    if (spec.delegates || spec.helperDelegates) {
      if (spec.register === false || !ctx.delegations) throw new Error('delegation requires a registered run');
      ctx.delegations.validate(spec.delegates ?? {}, spec.member, spec.helperDelegates);
    }
    // Same validation as the pin's NonEmptyString; preserve the caller's bytes (including whitespace).
    if (spec.idempotencyKey !== undefined && (typeof spec.idempotencyKey !== 'string' || !spec.idempotencyKey.length))
      throw new Error('refused: idempotencyKey must be a non-empty string');
    const idempotencyKey = spec.idempotencyKey ?? randomUUID();
    const output = preparedOutput ?? (spec.schema === undefined ? undefined : outputSchema(spec.schema));
    const system = [helper?.persona ?? spec.system, output?.prompt].filter(Boolean).join('\n\n');
    let catalogs: Promise<Record<string, { models?: unknown[] }> | undefined> | undefined;
    const accountOf = async (model: string): Promise<{ provider: string; model: string }> => {
      const picked = account(model);
      catalogs ??= ctx.request('config.get', {}).then(
        (answer) => (answer as { config?: { models?: { providers?: Record<string, { models?: unknown[] }> } } }).config?.models?.providers);
      const providers = await catalogs;
      return { provider: picked.provider, model: engineId(picked.provider, model, providers?.[picked.provider]?.models) };
    };
    const picked = spec.model === undefined ? undefined : await accountOf(spec.model);
    for (const need of spec.needs ?? []) await accountOf(need);
    for (const tool of spec.tools ?? [])
      if (!ctx.tools.has(tool)) throw new Error(`refused: "${tool}" is not one of this kit's tools`);
    // Runs step 1 (5.15): every run first finds the account its session is bound to, the API-key lane included.
    // A helper is bound to the agent whose sign-in it reads, as a conversation held there is.
    const binding = helper?.binding ?? (ctx.accounts ? await ctx.accounts.bind(spec.member, spec.sessionKey) : undefined);
    // Step 2 on the API-key lane: its own lane binding continues; any other binding is refused.
    if (keyAgent && ctx.accounts && binding) {
      const message = await ctx.accounts.keyRefusal(spec.member, binding);
      if (message !== undefined) return { ok: false, kind: 'other', message };
    }
    // A run that waited for its agent's lock across a move (5.15) binds again under it: a changed binding means its
    // session went to another account, so it ends before any event and the caller's retry lands there.
    const moved = async (): Promise<boolean> =>
      !helper && !!binding && (await ctx.accounts!.bind(spec.member, spec.sessionKey))?.agentId !== binding.agentId;
    const movedEnd = { ok: false as const, kind: 'other' as const, message: words('run.moved') };
    // Step 3: with `account` and `needs` both absent, on a key no account agent holds (or an API-key run, which binds only
    // to its lane), exactly the run on the agent it always was (a bound key under its shared lock).
    if ((keyAgent || binding?.id === undefined) && spec.account === undefined && !spec.needs?.length) {
      if (keyAgent) return start(spec, on, { agentId: keyAgent, sessionKey: `agent:${keyAgent}:${tail}`, idempotencyKey, system, picked, output });
      const { agentId } = await ctx.ensure(spec.member);
      const member = () => start(spec, on, { agentId, sessionKey: spec.sessionKey, idempotencyKey, system, picked, output });
      if (!binding || !ctx.locks) return member();
      return ctx.locks.shared(agentId, async () => await moved() ? movedEnd : member());
    }
    if (keyAgent) throw new Error('refused: an API-key run uses its own account');
    if (!ctx.accounts || !ctx.locks) throw new Error('gateway not ready');
    const accounts = ctx.accounts;
    const locks = ctx.locks;
    const restAccount = async (id: string, until: number | undefined): Promise<number> => {
      const at = until ?? Date.now() + REST_MS;
      await accounts.rest(spec.member, id, at);
      return at;
    };
    const signedIn = async (agentId: string, provider: string): Promise<boolean> =>
      !!(await ctx.request('byokit.accounts', { action: 'ready', agentId, provider }) as { ok?: boolean }).ok;
    const skipped: string[] = [];
    for (;;) {
      // Steps 2 and 4: the selection is resolved once per attempt, before any request, narrowed by the binding; `needs`
      // alone resolves as 'default'. A refusal (`bound`, `paid`) ends the run with its words before any room, model or agent request.
      const { pick, agent } = await accounts.pick(spec.member, { account: spec.account ?? 'default',
        ...(spec.model !== undefined ? { model: spec.model } : {}), ...(spec.needs ? { needs: spec.needs } : {}) }, skipped, binding);
      if (!pick.ok) {
        if (pick.code === 'unknown_account') throw new Error(`unknown account: ${spec.account}`); // a caller bug
        if (pick.code === 'resting') return { ok: false, kind: 'resting', until: await restAccount(pick.account, pick.until), message: pick.reason };
        return { ok: false, kind: pick.code === 'none' ? 'signed-out' : pick.code === 'not_included' ? 'plan' : 'other', message: pick.reason };
      }
      const sessionKey = `agent:${agent}:${tail}`;
      const automatic = pick.how === 'auto' || pick.why === 'first_ready';
      // The run goes to the picked account's agent, under the key's tail. The run holds the agent's shared
      // lock from its ready check to its end. An automatic pick not signed in is skipped before any event; an explicit
      // one announces itself, then ends signed-out.
      const end = await locks.shared(agent!, async (): Promise<RunEnd<SchemaOutput<S>> | undefined> => {
        if (await moved()) return movedEnd;
        let ready: boolean;
        try {
          ready = await signedIn(agent!, pick.account.provider);
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
        if (!ready && automatic) return undefined;
        const route = { session: sessionKey };
        ctx.routes.set(spec.sessionKey, route);
        try {
          on?.({ type: 'account', account: pick.account.id, model: pick.model, sessionKey, how: pick.how, why: pick.why, considered: pick.considered });
          if (!ready) return signedOut(pick.account.provider, `${pick.account.name} is not signed in`);
          return await start(spec, on, { agentId: agent!, sessionKey, idempotencyKey, system,
            picked: pick.model ? await accountOf(pick.model) : undefined, output, chosen: pick }); // '' = no override
        } finally {
          if (ctx.routes.get(spec.sessionKey) === route) ctx.routes.delete(spec.sessionKey);
        }
      });
      if (end === undefined) {
        skipped.push(pick.account.id);
        continue;
      }
      // Step 7: a resting end rests the account, so the next Auto skips it until then.
      if (end.ok || !('kind' in end) || end.kind !== 'resting') return end;
      const until = await restAccount(pick.account.id, end.until);
      return { ...end, until };
    }
  };
  const thinkingOf = async (picked: { provider: string; model: string } | undefined, asked: RunSpec['thinking']): Promise<ThinkingReport | undefined> => {
    if (asked === undefined) return undefined;
    if (!picked) return { asked, used: asked };
    try {
      const snap = await ctx.request('config.get', {}) as {
        config?: { models?: { providers?: Record<string, { models?: CatalogModel[] }> } };
      };
      return clampThinking(asked, levelsOf(catalogModelOf(snap.config?.models?.providers, picked.provider, picked.model)));
    } catch {
      return { asked, used: asked };
    }
  };
  const start = async <const S extends OutputSchema | undefined = undefined>(spec: RunSpec<S>, on: ((e: Emission) => void) | undefined, t: {
    agentId: string; sessionKey: string; idempotencyKey: string; system: string; picked?: { provider: string; model: string };
    output?: ReturnType<typeof outputSchema>; chosen?: Extract<AccountPick, { ok: true }>;
  }): Promise<RunEnd<SchemaOutput<S>>> => {
    const { agentId, sessionKey, idempotencyKey, system, picked, output, chosen } = t;
    let release: (() => void) | undefined;
    let releaseDelegation: (() => void) | undefined;
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
      const ref = { sessionKey, member: spec.member, ...(spec.helper !== undefined ? { helper: spec.helper } : {}) };
      releaseDelegation = spec.delegates || spec.helperDelegates
        ? ctx.delegations!.register(ref, idempotencyKey, spec.tools, spec.delegates ?? {}, spec.sessionKey, spec.helperDelegates, system) : undefined;
      release = spec.register !== false ? ctx.bridge.register(ref, spec.tools, idempotencyKey) : undefined;
      if (picked && !chosen) {
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
        // A sign-in the kit could not check (a slow or failed probe) is unknown: the run ends `network` (retry), never
        // `signed-out`, so no app signs the person out over it.
        if (!row && auth.unknown?.includes(picked.provider))
          return { ok: false, kind: 'network', message: `${picked.provider} could not be checked for ${spec.member}; try again` };
        if (!row || !usable(row))
          return signedOut(picked.provider, `${picked.provider} is not signed in for ${spec.member}`);
      }
      // One `agent` request: its interim `accepted` frame names the run, its final frame (after the run) carries the
      // run's usage. The wait below still decides how the run ended. Thinking is clamped to the catalog before the
      // request so an unsupported level (e.g. Muse's off/high/max) never fails the engine.
      const thinking = await thinkingOf(picked, spec.thinking);
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
        ...(thinking !== undefined ? { thinking: thinking.used } : {}),
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
        const reported = typeof agentMeta.provider === 'string' && typeof agentMeta.model === 'string'
          ? `${agentMeta.provider}/${agentMeta.model}`.toLowerCase() : '';
        return { ok: true, text, ...(parsed ? { data: parsed.data as SchemaOutput<S> } : {}), ...(usage ? { usage } : {}), ...(planWindow ? { planWindow } : {}),
          ...(chosen ? { account: chosen.account.id, model: chosen.model || reported } : {}),
          ...(thinking ? { thinking } : {}) };
      }
      if (result.stopReason === 'aborted' || (abortedByEngine && result.status !== 'ok')) return { ok: false, aborted: true };
      const message = typeof result.error === 'string' ? result.error
        : typeof result.message === 'string' ? result.message : '';
      return failure(message, picked?.provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(message, picked?.provider);
    } finally {
      ended = true;
      unsubscribe();
      release?.();
      releaseDelegation?.();
    }
  };
  const replay = ctx.replay ?? new RunReplay();
  return {
    run: async (spec, on, keyAgent, preparedOutput) => {
      if (spec.idempotencyKey !== undefined && (typeof spec.idempotencyKey !== 'string' || !spec.idempotencyKey.length))
        throw new Error('refused: idempotencyKey must be a non-empty string');
      const id = spec.idempotencyKey ?? randomUUID();
      const row = replay.begin(spec.member, id);
      let seq = 0;
      const emit = (e: Emission) => { const event = { ...e, seq: ++seq }; replay.push(row, event); on?.(event); };
      try {
        const end = await execute({ ...spec, idempotencyKey: id }, emit, keyAgent, preparedOutput);
        replay.push(row, { type: 'end', seq: ++seq, end });
        return end;
      } catch (error) {
        replay.push(row, { type: 'end', seq: ++seq, end: failure(error instanceof Error ? error.message : String(error)) });
        throw error;
      }
    },
    steer: (k, t) => ctx.request('sessions.steer', { sessionKey: ctx.routes.get(k)?.session ?? k, message: t }) as Promise<void>,
    abort: async (k) => { await ctx.request('chat.abort', { sessionKey: ctx.routes.get(k)?.session ?? k }); },
  };
}
