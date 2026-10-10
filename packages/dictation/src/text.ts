const wordKey = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Align decoded overlap text, allowing clipped words at either window's edge.
 * No token timestamps: retain the prefix through a shared phrase and continue
 * from the later window, which has more audio context for the first window's tail.
 */
export function mergeOverlap(previous: string, next: string): string {
  const before = previous.trim().split(/\s+/).filter(Boolean);
  const after = next.trim().split(/\s+/).filter(Boolean);
  const offset = Math.max(0, before.length - 40);
  const a = before.slice(offset).map(wordKey), b = after.slice(0, 40).map(wordKey);
  let exact = 0;
  for (let count = 1; count <= Math.min(a.length, b.length); count++) {
    if (a.slice(-count).every((word, i) => word && word === b[i])) exact = count;
  }
  if (exact >= 2) return [...before, ...after.slice(exact)].join(' ');
  // Semi-global word alignment: only a suffix of the earlier reading can
  // overlap a prefix of the later one. Penalize substitutions and skipped words
  // so a repeated phrase in the middle cannot swallow unrelated trailing text.
  const scores = Array.from({ length: a.length + 1 }, () => new Int16Array(b.length + 1));
  const steps = Array.from({ length: a.length + 1 }, () => new Uint8Array(b.length + 1));
  for (let j = 1; j <= b.length; j++) scores[0][j] = -2 * j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const match = a[i - 1] && a[i - 1] === b[j - 1];
      const diagonal = scores[i - 1][j - 1] + (match ? 3 : -2);
      const up = scores[i - 1][j] - 2, left = scores[i][j - 1] - 2;
      scores[i][j] = Math.max(diagonal, up, left);
      steps[i][j] = diagonal >= up && diagonal >= left ? 0 : up >= left ? 1 : 2;
    }
  }
  let end = 0;
  for (let j = 1; j <= b.length; j++) if (scores[a.length][j] > scores[a.length][end]) end = j;
  const matches: [number, number][] = [];
  for (let i = a.length, j = end; i > 0 && j > 0;) {
    const step = steps[i][j];
    if (step === 0) {
      i--; j--;
      if (a[i] && a[i] === b[j]) matches.push([offset + i, j]);
    } else if (step === 1) i--;
    else j--;
  }
  if (matches.length >= 2 && scores[a.length][end] >= matches.length) {
    // Join inside the agreed overlap, away from either clipped audio edge.
    const [left, right] = matches[Math.floor(matches.length / 2)];
    return [...before.slice(0, left + 1), ...after.slice(right + 1)].join(' ');
  }
  return [...before, ...after.slice(exact)].join(' ');
}
/** Whisper's no-speech marker; a shown sentinel is never a committed word. */
const isSilenceSentinel = (word: string) => /^\[blank_audio\]$/i.test(word);
/** Lifted from muxr: expose only agreeing words without retracting the prefix. */
export function settleWords(shown: string, previous: string, next: string): string {
  const before = previous.split(/\s+/).filter(Boolean);
  const after = next.split(/\s+/).filter(Boolean);
  const kept = shown.split(/\s+/).filter(Boolean);
  // A shown silence sentinel is not committed speech: drop it the moment a
  // reading carries real words. Real shown words keep today's policy, and a
  // silence-only take keeps its sentinel.
  if (kept.length && kept.every(isSilenceSentinel) && after.some(word => !isSilenceSentinel(word))) return '';
  let agreed = 0;
  while (agreed < before.length && agreed < after.length && wordKey(before[agreed]) === wordKey(after[agreed])) agreed++;
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
export function rms(data: Int16Array, scale = 4): number {
  if (!data.length) return 0;
  let sum = 0; for (const x of data) sum += (x / 32768) ** 2;
  return Math.min(1, Math.sqrt(sum / data.length) * scale);
}
