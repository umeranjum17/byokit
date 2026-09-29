// Account link without pasting a key (docs/machine-kit.md 11.5, G1).
// M1 stub: signature frozen, body lands in M8.
export type ClaimStep =
  | { step: 'open-page'; url: string }
  | { step: 'type-code'; url: string; code: string }
  | { step: 'waiting' }
  | { step: 'done'; key: string; expires: string | null; scopes: readonly string[] }
  | { step: 'failed'; why: 'refused' | 'expired' | 'unreachable' | 'provider' };

export function claim(o: { baseUrl: string; fetch?: typeof fetch; signal?: AbortSignal }): AsyncIterable<ClaimStep> {
  void o;
  throw new Error('not built: M8');
}
