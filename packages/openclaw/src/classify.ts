// Classify an engine error message into a person-visible kind, with `until` carried when present (5.8, O8).
// The regexes are Crewhouse `classifyText`; the kinds are the kit's: rate_limit|overloaded → resting,
// signed_out → signed-out, not_included → plan, network → network, anything unrecognised → other.
export function classify(message: string): { kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other'; until?: number } {
  // Kept in step with @byokit/accounts' classifyFailure: both read the retry delay from either wording.
  const retry = /(?:try again in|next reset in)\s*~?(\d+)\s*(min|h)/i.exec(message);
  const until = retry ? Date.now() + Number(retry[1]) * (retry[2].toLowerCase() === 'h' ? 3_600_000 : 60_000) : undefined;
  const kind = /your plan doesn't include/i.test(message) ? 'plan'
    : /usage limit|rate.?limit|quota|too many requests|\b429\b/i.test(message) ? 'resting'
    : /overloaded|high demand|\b50[234]\b|unavailable/i.test(message) ? 'resting'
    : /unauthori[sz]ed|\b40[13]\b|sign in again|expired|invalid.*token|authentication/i.test(message) ? 'signed-out'
    : /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONN|socket hang up/i.test(message) ? 'network'
    : 'other';
  return until === undefined ? { kind } : { kind, until };
}
