// The AI accounts a person can bring, by the name they know, with each provider's terms status as data (catalogue.json,
// readable from Kotlin too). The kit labels; the app decides what to offer. Claude plan sign-in is absent on purpose:
// Anthropic reserves it for its own apps, so no app can wire it by mistake. Meta and Kimi are left out too (a
// competitor by the owner's choice; Kimi refuses anything but coding agents).
import CATALOGUE from './catalogue.json' with { type: 'json' };

export type Terms = 'allowed' | 'grey' | 'partner' | 'forbidden';
/** `callbackPort`: where the provider sends the browser back after its own sign-in page, fixed for the client Pi signs in as. */
export type Provider = { key: string; pi: string; name: string; company: string; models: { strong: string; fast?: string }; callbackPort?: number; terms: Terms; hidden: boolean; why: string; source: string };

export const PROVIDERS: Record<string, Provider> = Object.fromEntries(Object.entries(CATALOGUE).map(([key, p]) => [key, { key, ...p } as Provider]));

export function provider(key: string) {
  const p = PROVIDERS[key];
  if (!p) throw Object.assign(new Error('no such AI account'), { status: 404 });
  return p;
}

/** What an app offers: the keys it names, in its order, or every provider not hidden by default. */
export const offered = (keys?: readonly string[]) => keys ? keys.map(provider) : Object.values(PROVIDERS).filter((p) => !p.hidden);
