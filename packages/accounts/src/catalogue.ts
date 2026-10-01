import CATALOGUE from './catalogue.json' with { type: 'json' };

/** How the person pays: their plan (`subscription`), or per-use charges to their account (`api`, never offered by default). */
export type Billing = 'subscription' | 'api';
/** Terms assessment for choosing between several accounts; descriptive, never an eligibility gate. */
export type MultiAccountTerms = { terms: 'allowed' | 'grey' | 'partner' | 'forbidden'; why: string; source: string };
/** `callbackPort`: where the provider sends the browser back after its own sign-in page, fixed for the client Pi signs in as.
 *  `revoke`: where signing out ends the sign-in on the provider's side too, for the client `clientId`. */
export type Provider = { key: string; pi: string; name: string; company: string; models: { strong: string; fast?: string }; fresh?: { param: string; value: string }; callbackPort?: number; clientId?: string; revoke?: string; billing: Billing; auth?: 'api-key' | 'oauth'; label?: string; offer?: boolean; source: string; multiAccount: MultiAccountTerms };

export const PROVIDERS: Record<string, Provider> = Object.fromEntries(Object.entries(CATALOGUE).map(([key, p]) => [key, { key, ...p } as Provider]));

export function provider(key: string) {
  const p = PROVIDERS[key];
  if (!p) throw Object.assign(new Error('no such AI account'), { status: 404 });
  return p;
}

/** What an app offers: the keys it names, in its order, or every subscription provider by default.
 *  API-billed rows are never in the default: an app offers them only by naming them. */
export const offered = (keys?: readonly string[]) => keys ? keys.map(provider) : Object.values(PROVIDERS).filter((p) => p.billing === 'subscription');
