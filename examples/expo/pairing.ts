import { normalizeCode, pairWithCode, pairWithOffer } from '@byokit/link';

export function pairInput(input: string, hostUrl: string, options: Parameters<typeof pairWithOffer>[1]) {
  const code = normalizeCode(input.trim());
  return code ? pairWithCode(hostUrl.trim(), code, options) : pairWithOffer(input.trim(), options);
}
