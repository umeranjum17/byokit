import { codexRequest } from './providers.ts';
import { record } from './windows.ts';
import type { Source } from './types.ts';

export type Identity = { signedIn: boolean; email?: string; plan?: string };
/** Explicit identity fields only: never walk arbitrary token-bearing objects. */
export function publicIdentity(raw: unknown, signedIn: boolean): Identity {
  if (!signedIn || !record(raw)) return { signedIn: false };
  const short = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 320 && !/[\x00-\x1f\x7f]/.test(value);
  const email = short(raw.email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email) ? raw.email : undefined;
  const plan = [raw.planType, raw.subscriptionType, raw.plan, raw.tier, raw.planName].find((value) => short(value) && /^[a-zA-Z][a-zA-Z0-9 _+-]{0,63}$/.test(value));
  return { signedIn: true, ...(email === undefined ? {} : { email }), ...(typeof plan === 'string' ? { plan } : {}) };
}
export async function codexIdentity(source: Extract<Source, { bin: string }>): Promise<Identity> {
  const answer = await codexRequest(source, 'account/read');
  const account = record(answer.raw) ? answer.raw.account : undefined;
  return publicIdentity(account, record(account));
}
