import type { Keystore } from '@byokit/secrets';
import { say } from './words.ts';

/** An OpenCode Go plan account (route `opencode:plan_key:opencode-go`). `access` reads the saved plan
 * key from the caller's store (Accounts member key, or the route seam below). Never falls back to API billing.
 * `workspace` names the account's workspace when its key needs one (`''` when not), so callers carry
 * `x-opencode-org-id` on every Go call; a key that needs no workspace keeps working with no header. */
export type OpenCodeGoAccount = {
  readonly billing: 'subscription';
  /** Provider tag: a plan handle only reaches its own provider's endpoint. */
  readonly provider: 'opencode-go';
  access(signal: AbortSignal): Promise<string>;
  workspace?(signal: AbortSignal): Promise<string>;
};

/** One workspace (the OpenCode console calls it an org) a login key can act for. Ids are row ids, never secrets. */
export type OpenCodeGoWorkspace = { id: string; name: string };

const CONSOLE = 'https://opencode.ai/console';

/** The workspaces a plan key can act for, from the OpenCode console's own listing (the same call the
 * OpenCode CLI makes after sign-in). A key that is not a person's login (a service key bound to one
 * workspace, or anything the console refuses) answers empty: it needs no workspace header. */
export async function openCodeWorkspaces(key: string, fetcher: typeof fetch = fetch): Promise<OpenCodeGoWorkspace[]> {
  if (typeof key !== 'string' || !key.trim()) return [];
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 10_000);
  try {
    const res = await fetcher(`${CONSOLE}/api/orgs`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: control.signal });
    if (res.status !== 200 || !res.body) return [];
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return [];
    return raw.filter((o): o is { id: string; name: string } =>
      !!o && typeof o === 'object' && typeof (o as { id?: unknown }).id === 'string' && !!(o as { id?: string }).id &&
      typeof (o as { name?: unknown }).name === 'string').map((o) => ({ id: o.id, name: o.name }));
  } catch { return []; } finally { clearTimeout(timer); }
}

/** The plan-key route this seam keeps. Portable callers keep one store entry per route; managed CLI
 * accounts append the account id so two accounts each keep their own key. */
export const OPENCODE_GO_PLAN_ROUTE = 'opencode:plan_key:opencode-go';

/** The secrets entry holding a plan key. With only `route`, the name is `accounts.<route>` (portable
 * `openCodeGoPlanAccount`). With `accountId`, Go uses `accounts.<route>:<accountId>`; other routes keep `.<accountId>`.
 * The name carries only ids, never the key. */
export function openCodePlanKeyEntry(route: string = OPENCODE_GO_PLAN_ROUTE, accountId?: string): string {
  if (typeof route !== 'string' || !route || route.includes('\0') || route.length > 256) throw new Error(say('cli.badOption'));
  if (accountId !== undefined) {
    if (typeof accountId !== 'string' || !accountId || accountId.includes('\0') || accountId.length > 256) throw new Error(say('cli.badOption'));
    return `accounts.${route}${route === OPENCODE_GO_PLAN_ROUTE ? ':' : '.'}${accountId}`;
  }
  return `accounts.${route}`;
}

/** Save a plan key (the app collects it with hidden typing; this call never logs it). */
export async function saveOpenCodePlanKey(store: Keystore, key: string, route: string = OPENCODE_GO_PLAN_ROUTE, accountId?: string): Promise<void> {
  if (!store || typeof key !== 'string' || !key.trim()) throw new Error(say('cli.badOption'));
  await store.set(openCodePlanKeyEntry(route, accountId), key);
}

/** The secrets entry holding the account's workspace id. It rides the key's own entry name, so it is
 * saved and dropped with the key and never collides with another account's. */
export function openCodeWorkspaceEntry(route: string = OPENCODE_GO_PLAN_ROUTE, accountId?: string): string {
  return `${openCodePlanKeyEntry(route, accountId)}.workspace`;
}

/** Save the workspace this account's calls must name. Empty or overlong values are refused. */
export async function saveOpenCodeWorkspace(store: Keystore, workspace: string, route: string = OPENCODE_GO_PLAN_ROUTE, accountId?: string): Promise<void> {
  if (!store || typeof workspace !== 'string' || !workspace.trim() || workspace.length > 256) throw new Error(say('cli.badOption'));
  await store.set(openCodeWorkspaceEntry(route, accountId), workspace.trim());
}

/** Read the saved workspace; `''` when this account needs none. */
export async function readOpenCodeWorkspace(store: Keystore | undefined, route: string = OPENCODE_GO_PLAN_ROUTE, accountId?: string): Promise<string> {
  const value = await store?.get(openCodeWorkspaceEntry(route, accountId));
  return typeof value === 'string' ? value : '';
}

/** Read a saved plan key. Go also accepts the previous per-account dot spelling.
 * Route-only migration belongs to the managed roster, which knows the first account. */
export async function readOpenCodePlanKey(store: Keystore | undefined, route: string = OPENCODE_GO_PLAN_ROUTE, name = 'OpenCode', accountId?: string): Promise<string> {
  const key = await store?.get(openCodePlanKeyEntry(route, accountId));
  if (typeof key === 'string' && key) return key;
  if (route === OPENCODE_GO_PLAN_ROUTE && accountId !== undefined) {
    const legacy = await store?.get(`accounts.${route}.${accountId}`);
    if (typeof legacy === 'string' && legacy) return legacy;
  }
  throw new Error(say('cli.missingPlanKey', { name }));
}

/** Delete a saved plan key. A missing entry is already signed out, not a failure. The workspace rides the key down. */
export async function deleteOpenCodePlanKey(store: Keystore | undefined, route: string = OPENCODE_GO_PLAN_ROUTE, accountId?: string): Promise<void> {
  if (!store) return;
  await store.delete(openCodePlanKeyEntry(route, accountId));
  await store.delete(openCodeWorkspaceEntry(route, accountId));
  if (route === OPENCODE_GO_PLAN_ROUTE && accountId !== undefined) await store.delete(`accounts.${route}.${accountId}`);
}

/** The plan route's own handle: resolves its key from the store on every use, so a BYOKit-only live
 * call needs no hand-exported key. Never reads OpenCode's own auth.json. */
export function openCodeGoPlanAccount(store: Keystore, route: string = OPENCODE_GO_PLAN_ROUTE): OpenCodeGoAccount {
  return { billing: 'subscription', provider: 'opencode-go', access: async () => readOpenCodePlanKey(store, route),
    workspace: async () => readOpenCodeWorkspace(store, route) };
}
