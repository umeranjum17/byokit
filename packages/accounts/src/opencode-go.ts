import type { Keystore } from '@byokit/secrets';
import { say } from './words.ts';

/** An OpenCode Go plan account (route `opencode:plan_key:opencode-go`). `access` reads the saved plan
 * key from the caller's store (Accounts member key, or the route seam below). Never falls back to API billing. */
export type OpenCodeGoAccount = {
  readonly billing: 'subscription';
  /** Provider tag: a plan handle only reaches its own provider's endpoint. */
  readonly provider: 'opencode-go';
  access(signal: AbortSignal): Promise<string>;
};

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

/** Delete a saved plan key. A missing entry is already signed out, not a failure. */
export async function deleteOpenCodePlanKey(store: Keystore | undefined, route: string = OPENCODE_GO_PLAN_ROUTE, accountId?: string): Promise<void> {
  if (!store) return;
  await store.delete(openCodePlanKeyEntry(route, accountId));
  if (route === OPENCODE_GO_PLAN_ROUTE && accountId !== undefined) await store.delete(`accounts.${route}.${accountId}`);
}

/** The plan route's own handle: resolves its key from the store on every use, so a BYOKit-only live
 * call needs no hand-exported key. Never reads OpenCode's own auth.json. */
export function openCodeGoPlanAccount(store: Keystore, route: string = OPENCODE_GO_PLAN_ROUTE): OpenCodeGoAccount {
  return { billing: 'subscription', provider: 'opencode-go', access: async () => readOpenCodePlanKey(store, route) };
}
