const wordKey = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Lifted from muxr: expose only agreeing words without retracting the prefix. */
export function settleWords(shown: string, previous: string, next: string): string {
  const before = previous.split(/\s+/).filter(Boolean);
  const after = next.split(/\s+/).filter(Boolean);
  let agreed = 0;
  while (agreed < before.length && agreed < after.length && wordKey(before[agreed]) === wordKey(after[agreed])) agreed++;
  const kept = shown.split(/\s+/).filter(Boolean);
  if (agreed <= kept.length || kept.some((word, i) => wordKey(word) !== wordKey(after[i] ?? ''))) return shown;
  return after.slice(0, agreed).join(' ');
}
export function applyWordReplacements(text: string, replacements: Record<string, string> = {}): string {
  for (const [from, to] of Object.entries(replacements)) {
    if (!from.trim() || !to.trim()) continue;
    const escaped = from.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), (match: string, at: number, source: string) =>
      /[\p{L}\p{N}_]/u.test(source[at - 1] ?? '') || /[\p{L}\p{N}_]/u.test(source[at + match.length] ?? '') ? match : to.trim());
  }
  return text;
}
/** WAV transport for app-injected PCM; explicit LE encoding works on any host. */
export function wav(samples: readonly Int16Array[]): Uint8Array {
  const count = samples.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(44 + count * 2), v = new DataView(out.buffer);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, out.length - 8, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, count * 2, true);
  let at = 44; for (const s of samples) for (const x of s) { v.setInt16(at, x, true); at += 2; }
  return out;
}
export function rms(data: Int16Array): number {
  if (!data.length) return 0;
  let sum = 0; for (const x of data) sum += (x / 32768) ** 2;
  return Math.min(1, Math.sqrt(sum / data.length) * 4);
}
