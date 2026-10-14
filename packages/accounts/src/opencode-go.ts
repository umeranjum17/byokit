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

/** The plan-key route this seam keeps: one @byokit/secrets entry per route. */
export const OPENCODE_GO_PLAN_ROUTE = 'opencode:plan_key:opencode-go';

/** The secrets entry holding a plan route's key. The key never lives in argv, an env line, a file
 * outside the store, or a log; this name carries only the route, never the key. */
export function openCodePlanKeyEntry(route: string = OPENCODE_GO_PLAN_ROUTE): string {
  if (typeof route !== 'string' || !route || route.includes('\0') || route.length > 256) throw new Error(say('cli.badOption'));
  return `accounts.${route}`;
}

/** Save a plan route's key (the app collects it with hidden typing; this call never logs it). */
export async function saveOpenCodePlanKey(store: Keystore, key: string, route: string = OPENCODE_GO_PLAN_ROUTE): Promise<void> {
  if (!store || typeof key !== 'string' || !key.trim()) throw new Error(say('cli.badOption'));
  await store.set(openCodePlanKeyEntry(route), key);
}

/** Read a plan route's saved key. A missing key fails with words, never with key material. */
export async function readOpenCodePlanKey(store: Keystore | undefined, route: string = OPENCODE_GO_PLAN_ROUTE): Promise<string> {
  const key = await store?.get(openCodePlanKeyEntry(route));
  if (typeof key !== 'string' || !key) throw new Error(say('cli.missingPlanKey', { name: 'OpenCode' }));
  return key;
}

/** Delete a plan route's saved key. A missing entry is already signed out, not a failure. */
export async function deleteOpenCodePlanKey(store: Keystore | undefined, route: string = OPENCODE_GO_PLAN_ROUTE): Promise<void> {
  if (!store) return;
  await store.delete(openCodePlanKeyEntry(route));
}

/** The plan route's own handle: resolves its key from the store on every use, so a BYOKit-only live
 * call needs no hand-exported key. Never reads OpenCode's own auth.json. */
export function openCodeGoPlanAccount(store: Keystore, route: string = OPENCODE_GO_PLAN_ROUTE): OpenCodeGoAccount {
  return { billing: 'subscription', provider: 'opencode-go', access: async () => readOpenCodePlanKey(store, route) };
}
