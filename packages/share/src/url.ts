/** Accept only the link formats produced by the app's share extension. */
export function isValidShareUrl(url: string, scheme: string | null): boolean {
  if (!scheme) return false;
  const escaped = scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}://dataUrl=${escaped}ShareKey(\\?[^#]*)?#(media|text|weburl|file)$`).test(url);
}
