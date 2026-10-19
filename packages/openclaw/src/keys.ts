import { join } from 'node:path';
import { KeyRouteError } from '@byokit/accounts';
import { openCodeWorkspaces, type OpenCodeGoWorkspace } from '@byokit/accounts/opencode-go';
import { activate, type ActivationCtx } from './activation.ts';
import { keyAgentId, MEMBER_ID, KEY_PREFIX, untilListed } from './members.ts';
import { providerOf } from './pick.ts';
import type { RouteView } from './routes.ts';
import { modelsOf } from './accounts.ts';
import { LIVE_CATALOGS, REGISTERED_CATALOGS } from './constants.ts';
import type { Member, ModelInfo } from './types.ts';

// retry: the engine may have taken the key but it was not kept; the unsealed key is cleared best-effort. If that clear
// does not reach the engine, the key stays unsealed and unusable until the next key add or kit start, and runs fail
// closed meanwhile.
export type KeyFailureReason = 'auth' | 'billing' | 'empty' | 'model' | 'network' | 'engine' | 'inference' | 'busy';
/** `needs_workspace`: the Go plan login acts for several workspaces (console orgs); show the pick and add again with
 *  its `orgId`. Nothing was saved or sent to the engine. Ids are row ids, never secrets. `retry`'s `code` and `message`
 *  are set only for a typed `@byokit/accounts` listing failure (`workspaces_unread`); `message` is the words to show. */
export type AddKeyResult = { status: 'ok' } |
  { status: 'invalid' | 'not_included'; reason: KeyFailureReason } |
  { status: 'retry'; reason: KeyFailureReason; code?: string; message?: string } |
  { status: 'needs_workspace'; workspaces: { id: string; name: string }[] };
/** The add resolves like a Promise; `cancel()` stops a pending add and clears any partial key (retry/busy). */
export type AddKeyHandle = Promise<AddKeyResult> & { cancel(): void };

export function createKeys(ctx: ActivationCtx & {
  root: string;
  routes(): RouteView[]; // readiness with the external plugins the kit installed (B7)
  ensure(member: Member): Promise<{ agentId: string }>;
  restarting?(): boolean;
  prepareOwner(agentId: string): Promise<void>;
  indexLane(member: Member, route: RouteView): Promise<void>;
  dropLane(member: Member, provider?: string): Promise<void>;
  backfillLane(member: Member, model: string | undefined): Promise<void>;
  /** The provider config headers a Go key's calls and probes must carry (`null` clears them),
   *  written through the kit's own config patch. The Go workspace header is the one user. */
  setProviderHeaders(provider: string, headers: Record<string, string> | null): Promise<void>;
  /** Adds catalog rows to the engine's `models.providers[provider].models`, serialized with catalog sync. */
  registerModels(provider: string, rows: Record<string, unknown>[]): Promise<void>;
}) {
  // Serialize key replacement and key runs, so an in-flight run never sees a half-installed replacement.
  const tails = new Map<string, Promise<unknown>>();
  const exclusive = async <T>(member: Member, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(member) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    tails.set(member, next);
    try { return await next; }
    finally { if (tails.get(member) === next) tails.delete(member); }
  };
  const check = (member: Member) => MEMBER_ID.test(member) && !member.startsWith(KEY_PREFIX);
  // Config writes may drain/restart the gateway: a restart, or a retryable refusal, means the call may simply run again.
  const transient = (error: unknown): boolean => {
    const refusal = error as { code?: string; retryable?: boolean } | null;
    return Boolean(ctx.restarting?.() || (refusal?.code === 'UNAVAILABLE' && refusal.retryable === true));
  };
  const control = (member: Member, action: 'prepare' | 'seal' | 'ready' | 'clear', provider?: string, model?: string) =>
    ctx.request('byokit.keys', { member, action, ...(provider ? { provider } : {}), ...(model ? { model } : {}) }) as
      Promise<{ ok: boolean; model?: string; absent?: boolean }>;
  const failure = (status: 'invalid' | 'not_included' | 'retry', reason: KeyFailureReason): AddKeyResult => ({ status, reason });
  // Only a provider refusal is `invalid`; an unavailable route or model is `not_included`; everything else may be retried.
  const probeResult = (status: string | undefined): AddKeyResult => {
    switch (status) {
      case 'auth': return failure('invalid', 'auth');
      case 'billing': return failure('invalid', 'billing');
      case 'unavailable': case 'no_model': return failure('not_included', 'model');
      case 'timeout': case 'network': return failure('retry', 'network');
      case 'rate_limit': case 'busy': return failure('retry', 'busy');
      case 'format': case 'unknown': return failure('retry', 'inference');
      default: return failure('retry', 'engine');
    }
  };
  const registered = async (provider: string, model: string): Promise<boolean> => {
    const { config } = await ctx.request('config.get') as
      { config?: { models?: { providers?: Record<string, { models?: { id: string }[] }> } } };
    return Boolean(config?.models?.providers?.[provider]?.models?.some((m) => `${provider}/${m.id}` === model));
  };
  const errorReason = (error: unknown, sent: boolean): KeyFailureReason => {
    if (transient(error)) return 'busy';
    const e = error as { code?: string; name?: string } | null;
    if (sent && e?.code === 'INVALID_REQUEST') return 'inference';
    return ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'CLIENT_TIMEOUT', 'NETWORK_ERROR'].includes(e?.code ?? '')
      || e?.name === 'TimeoutError' ? 'network' : 'engine';
  };
  // The live catalog's rows, as the engine registers them (provider-local ids).
  const catalog = async (member: Member, provider: string): Promise<Record<string, unknown>[]> => {
    await ctx.ensure(member);
    const answer = await ctx.request('byokit.catalog', { provider }) as
      { ok: boolean; reason?: string; models?: Record<string, unknown>[] };
    if (answer.ok) return answer.models ?? [];
    if (answer.reason !== 'no-key') throw new Error('Model catalog is unavailable.');
    return [];
  };
  // Catalog ids may hold a slash of their own (OpenRouter's `deepseek/...`), so each is named `<provider>/<id>`.
  const fullId = (provider: string, row: Record<string, unknown>) => `${provider}/${String(row.id)}`;
  const listed = (provider: string, rows: Record<string, unknown>[]): ModelInfo[] =>
    modelsOf(provider, { models: rows.map((m) => ({ ...m, id: fullId(provider, m), provider })) });
  const models = async (member: Member, o: { authChoice: string }): Promise<ModelInfo[]> => {
    if (!check(member)) throw new Error('Choose your own member.');
    const route = ctx.routes().find((r) => r.choice === o.authChoice && r.keyEntry && r.readiness === 'ready');
    if (!route || !LIVE_CATALOGS.includes(route.provider)) return [];
    return listed(route.provider, await catalog(member, route.provider));
  };
  return {
    models,
    exclusive,
    add(member: Member, o: { authChoice: string; apiKey: string; model?: string; orgId?: string }): AddKeyHandle {
      const ac = new AbortController();
      const cancel = (): void => { if (!ac.signal.aborted) ac.abort(); };
      const done = (async (): Promise<AddKeyResult> => {
        if (!check(member)) throw new Error('Choose your own member.');
        if (!o.apiKey.trim()) return failure('invalid', 'empty');
        const route = ctx.routes().find((r) => r.choice === o.authChoice && r.keyEntry && r.readiness === 'ready');
        if (!route || (o.model !== undefined && !LIVE_CATALOGS.includes(route.provider))) return failure('not_included', 'model');
        // A workspace names a Go login's own workspace only; another route takes no header, and a
        // refusal here leaves the member's lanes untouched (it lands before any prepare or activation).
        let orgId = typeof o.orgId === 'string' ? o.orgId.trim() : '';
        if (orgId) {
          if (orgId.length > 256) return failure('invalid', 'auth');
          if (route.provider !== 'opencode-go') return failure('not_included', 'model');
        } else if (route.provider === 'opencode-go') {
          // The Go gateway refuses a login acting for several workspaces until one is named (403 Workspace selection
          // is required), so an add without `orgId` lists the key's own (the console listing `@byokit/accounts` uses):
          // one is used, several come back for the app's pick, and a key the console refuses (a workspace-bound
          // service key) needs none. A listing that could not be read fails the add before anything changes.
          let workspaces: OpenCodeGoWorkspace[];
          try {
            workspaces = await openCodeWorkspaces(o.apiKey, (input, init) =>
              fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal }));
          } catch (error) { // `workspaces_unread`: offline, timeout, a server error or a body that is no list
            if (ac.signal.aborted) return failure('retry', 'busy');
            if (!(error instanceof KeyRouteError)) return failure('retry', 'network');
            return { status: 'retry', reason: 'network', code: error.code, message: error.message };
          }
          if (ac.signal.aborted) return failure('retry', 'busy');
          if (workspaces.length > 1) return { status: 'needs_workspace', workspaces };
          orgId = workspaces[0]?.id ?? '';
        }
        if (ac.signal.aborted) return failure('retry', 'busy');
        return exclusive(member, async () => {
          let sent = false;
          // A key the engine may have taken but not sealed is cleared (prepare already emptied the agent); if the clear
          // does not reach the engine, the key stays unsealed and unusable until the next key add or kit start, so runs
          // fail closed.
          let wroteHeader = false;
          const abandon = async (result: AddKeyResult): Promise<AddKeyResult> => {
            await control(member, 'clear').catch(() => undefined);
            // A header this add wrote must not outlive its abandoned key; a clear that fails never throws past
            // the abandon, like the key clear itself.
            if (wroteHeader) await ctx.setProviderHeaders(route.provider, null).catch(() => undefined);
            return result;
          };
          const cancelled = () => failure('retry', 'busy');
          try {
            if (ac.signal.aborted) return cancelled();
            await ctx.ensure(member);
            const agentId = keyAgentId(member);
            const list = await ctx.request('agents.list') as { agents: { id: string }[] };
            if (!list.agents.some((a) => a.id === agentId))
              await ctx.request('agents.create', { name: agentId, workspace: join(ctx.root, 'key-workspaces', member) });
            // Creation answers before the runtime roster/owners publish, just as for ordinary members.
            await untilListed(ctx.request, agentId);
            if (ac.signal.aborted) return cancelled();
            if (!(await control(member, 'prepare', route.provider)).ok) return failure('retry', 'engine');
            // The workspace rides the provider's probe and every run from its config; it is written before the
            // activation, so the probe itself carries it. The slot is provider-wide (shared by every member's
            // key on this engine), so a workspace-scoped add that names none clears the standing one before the
            // probe: a bound service key never carries another workspace, and `removeKey` drops it.
            if (orgId) {
              await ctx.setProviderHeaders(route.provider, { 'x-opencode-org-id': orgId });
              wroteHeader = true;
            } else if (route.provider === 'opencode-go') {
              await ctx.setProviderHeaders(route.provider, null);
              wroteHeader = true;
            }
            // The public pin's typed API-key path, never a CLI-login import. Discard the engine's lines/errors.
            sent = true;
            if (ac.signal.aborted) return abandon(cancelled());
            const result = await activate(ctx, { kind: 'api-key', agentId, authChoice: o.authChoice, apiKey: o.apiKey },
              { timeoutMs: 180_000, signal: ac.signal });
            if (ac.signal.aborted) return abandon(cancelled());
            if (!result.ok && !result.late) return abandon(probeResult(result.status));
            if (result.late) return abandon(failure('retry', 'busy'));
            const rows = o.model === undefined ? [] : await catalog(member, route.provider);
            if (o.model !== undefined && !listed(route.provider, rows).some((m) => m.id === o.model && m.available))
              return abandon(failure('not_included', 'model'));
            // Prepare before publishing the ready marker: failed preparation remains unusable even if clear fails.
            try { await ctx.prepareOwner(agentId); }
            catch { return abandon(failure('retry', 'engine')); }
            if (ac.signal.aborted) return abandon(cancelled());
            // A live catalog the kit does not register whole (OpenRouter) registers the chosen model alone.
            if (o.model !== undefined && !REGISTERED_CATALOGS.includes(route.provider))
              await ctx.registerModels(route.provider, rows.filter((m) => fullId(route.provider, m) === o.model)).catch(() => {});
            if (o.model !== undefined && LIVE_CATALOGS.includes(route.provider) && !(await registered(route.provider, o.model)))
              return abandon(failure('retry', 'model'));
            if (!(await control(member, 'seal', undefined, o.model)).ok) return abandon(failure('retry', 'engine'));
            await ctx.indexLane(member, route);
            return { status: 'ok' };
          } catch (error) {
            const reason = errorReason(error, sent);
            if (sent) return abandon(failure('retry', reason));
            return failure('retry', reason);
          }
        });
      })();
      return Object.assign(done, { cancel });
    },
    async ready(member: Member, o: { once?: boolean } = {}): Promise<{ agentId: string; model: string } | undefined> {
      if (!check(member)) return undefined;
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const ready = await control(member, 'ready');
          return ready.ok && ready.model ? { agentId: keyAgentId(member), model: ready.model } : undefined;
        } catch (error) {
          // This read is safe to retry; an absent profile or a terminal refusal still fails closed immediately.
          if (o.once || !transient(error) || Date.now() >= deadline) return undefined;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
    // Remove this member's saved key: the key agent's store and its ready marker, so the lane reads signed out and
    // stays signed out, plus its `<provider>.key` index entry, so the accounts list stops naming the removed key.
    // `provider` scopes it to the key actually saved for that provider (the member agent's own
    // sign-out never reaches this lane), so signing out of one provider never drops another's key. A lane that reads
    // not ready has nothing saved to remove; a refused read or clear is a typed refusal, never raw engine text.
    // Serialized with adds and key runs like every other key change.
    async remove(member: Member, o: { provider?: string } = {}): Promise<void> {
      if (!check(member)) throw new Error('Choose your own member.');
      await exclusive(member, async () => {
        const refused = (): never => { throw new Error('The key could not be removed.'); };
        if (o.provider !== undefined) {
          // An unreadable lane cannot name its provider, so removal never guesses and risks another provider's key.
          const ready = await control(member, 'ready').catch(() => undefined);
          if (!ready) refused();
          else if (ready.ok !== true || providerOf(ready.model ?? '') !== o.provider) return;
        }
        // The lane's own provider, when the removal can name it: the header clear below is scoped like the removal.
        const cleared = await control(member, 'clear').catch(() => undefined);
        if (cleared?.ok !== true && cleared?.absent !== true) refused();
        // A workspace header the removed key named must not outlive it; the next add names its own (or none).
        if (o.provider === 'opencode-go')
          await ctx.setProviderHeaders(o.provider, null).catch(() => { throw new Error('The key could not be removed.'); });
        await ctx.dropLane(member, o.provider);
      });
    },
    // Kit connect calls this once the gateway is ready: a failed add whose abandon clear never reached the engine
    // leaves an unsealed key with no ready marker, so drop it (`clear`, until a sweep completes). A single ready read
    // per key agent, no retries; an add in flight for that member is waited for. Only an absent marker is cleared; a
    // refused read or clear (the gateway left ready) makes the sweep incomplete. A sealed lane is backfilled on every
    // call. Resolves true once every key agent was read.
    async sweep(clear: boolean): Promise<boolean> {
      let agents: { id: string }[];
      try {
        agents = ((await ctx.request('agents.list')) as { agents: { id: string }[] }).agents;
      } catch { return false; }
      let complete = true;
      for (const agent of agents) {
        if (!agent.id.startsWith(KEY_PREFIX)) continue;
        const member = agent.id.slice(KEY_PREFIX.length) as Member;
        if (!check(member)) continue;
        await exclusive(member, async () => {
          const ready = await control(member, 'ready').catch(() => undefined);
          if (ready?.ok === true) {
            await ctx.backfillLane(member, ready.model);
            return;
          }
          if (!clear) return;
          if (ready?.absent !== true) { complete = false; return; }
          const cleared = await control(member, 'clear').catch(() => undefined);
          if (cleared?.ok !== true) complete = false;
        });
      }
      return complete;
    },
  };
}
