// bench-infer.sh's reader: the speed line of the newest GGUF result or Nano timing in a lab logcat.
//   node bench-speed.mjs <logcat.txt> gguf|nano|count-gguf|count-nano|count-failed
import { readFileSync } from 'node:fs';

const [file, kind] = process.argv.slice(2);
const lines = readFileSync(file, 'utf8').split('\n');
const count = re => lines.filter(l => re.test(l)).length;
if (kind === 'count-gguf') console.log(count(/infer-completion (result|rejection) (\d+)\/\2 /));
else if (kind === 'count-nano') console.log(count(/infer-nano-timing /));
else if (kind === 'count-failed') console.log(count(/infer-probe (exception\.|state\.failed|nano\.failed)/));
else if (kind === 'gguf') {
  // `infer-completion result i/n <chunk>`: 512-character chunks of {kind, chars, truncated, json}.
  let buf = '', last;
  for (const l of lines) {
    const m = /infer-completion result (\d+)\/(\d+) (.*)$/.exec(l);
    if (!m) continue;
    if (m[1] === '1') buf = '';
    buf += m[3];
    if (m[1] === m[2]) last = JSON.parse(JSON.parse(buf).json);
  }
  const t = last.timings ?? {};
  console.log(`ttft_ms=${last.firstTokenMs} decode_tok_s=${t.predicted_per_second?.toFixed(2)} prompt_tokens=${t.prompt_n} ` +
    `(prompt ${t.prompt_per_second?.toFixed(1)} tok/s, ${Math.round(t.prompt_ms)} ms) output_tokens=${t.predicted_n} total_ms=${last.elapsedMs}`);
} else if (kind === 'nano') {
  const l = lines.filter(x => x.includes('infer-nano-timing ')).at(-1);
  const n = JSON.parse(l.slice(l.indexOf('infer-nano-timing ') + 18));
  const decodeMs = n.totalMs - n.firstTextMs;
  console.log(`ttft_ms=${n.firstTextMs} decode_tok_s=${n.outputTokens > 1 && decodeMs > 0 ? ((n.outputTokens - 1) / decodeMs * 1000).toFixed(2) : 'n/a'} ` +
    `end_to_end_tok_s=${(n.outputTokens / n.totalMs * 1000).toFixed(2)} prompt_tokens=${n.inputTokens} (system ${n.systemChars} + prompt ${n.promptChars} chars) output_tokens=${n.outputTokens} stream_pieces=${n.pieces} total_ms=${n.totalMs} finish=${n.finishReason}`);
} else throw new Error(`unknown kind ${kind}`);
