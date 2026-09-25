// An account's error in the kinds an app acts on, and when it said to come back. v1 reads errors only: no usage endpoint.
export type Kind = 'rate_limit' | 'overloaded' | 'signed_out' | 'not_included' | 'network';
/** How long an account rests when its error didn't say. */
export const REST_MS: Record<Kind, number> = { rate_limit: 60 * 60_000, overloaded: 5 * 60_000, signed_out: 0, not_included: 0, network: 0 };

/** `until` is 0 when the error didn't say. Anything unrecognised is null: the app fails that one request. */
export function classify(error: string): { kind: Kind; until: number } | null {
  const m = /try again in ~?(\d+)\s*(min|h)/i.exec(error);
  const until = m ? Date.now() + Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 60_000) : 0;
  // ChatGPT words "your plan doesn't include this" (usage_not_included) like a limit, but with no time to come back.
  // ponytail: told apart by the missing "try again"; a real limit always says when it resets.
  if (/usage limit/i.test(error) && !m) return { kind: 'not_included', until };
  if (/usage limit|rate.?limit|quota|too many requests|\b429\b/i.test(error)) return { kind: 'rate_limit', until };
  if (/overloaded|high demand|\b50[234]\b|unavailable/i.test(error)) return { kind: 'overloaded', until };
  if (/unauthori[sz]ed|\b40[13]\b|sign in again|expired|invalid.*token|authentication/i.test(error)) return { kind: 'signed_out', until };
  if (/fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONN|socket hang up/i.test(error)) return { kind: 'network', until };
  return null;
}
