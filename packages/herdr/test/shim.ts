// A test-written herdr CLI shim (docs/runtime-kits.md §11.3 H4 acceptance): no real Herdr, no lifecycle —
// a plain Node script the tests spawn the way the kit spawns `bin`. Tests write it into a temp dir, 0700.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Shim = { dir: string; bin: string; out: string; dispose(): Promise<void> };

const SHIM = `#!${process.execPath}
import { writeFileSync } from 'node:fs';

// The shebang pins the running Node binary: the kit passes the env verbatim, so the child's PATH may not
// contain node (CI runners keep it out of /usr/bin:/bin) — /usr/bin/env node would exit 127 there.

// Every mode records { argv, env } to SHIM_OUT when set, so tests can assert what the kit actually passed.
const record = () => {
  if (process.env.SHIM_OUT) writeFileSync(process.env.SHIM_OUT, JSON.stringify({ argv: process.argv.slice(2), env: { ...process.env } }));
};
const mode = process.argv[2];

if (mode === 'record') {
  record();
  process.stdout.write('to out\\n');
  process.stderr.write('to err\\n');
  process.exit(7);
} else if (mode === 'hang') {
  record();
  setTimeout(() => process.exit(0), 60_000);   // stays alive until the kit's timeout kills it
} else if (mode === 'flood') {
  record();
  const big = 'x'.repeat(1024 * 1024);
  let i = 0;
  const w = () => {
    while (i < 16) { i++; if (!process.stdout.write(big)) { process.stdout.once('drain', w); return; } }
  };
  w();
} else if (mode === 'terminal') {
  record();
  if (process.env.SHIM_MODE === 'die') {       // exits before any stdout line, leaving a stderr tail
    process.stderr.write('boom: bad args\\n');
    process.exit(3);
  }
  process.stdout.write('{"type":"ready"}\\n');
  if (process.env.SHIM_MODE === 'frames') {    // emits fixed frames after a 'go' line, echoes every other line
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line === 'go') {
          process.stdout.write('crlf stays\\r\\n');
          process.stdout.write('{"emoji":"🚿 \\\\"quoted\\\\" \\\\\\\\ done"}\\n');
        } else {
          process.stdout.write('echo:' + line + '\\n');
        }
      }
    });
  }
}
`;

export async function makeShim(): Promise<Shim> {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-h4-'));
  const bin = join(dir, 'herdr-shim.mjs');
  await writeFile(bin, SHIM, { mode: 0o700 });
  return { dir, bin, out: join(dir, 'record.json'), dispose: () => rm(dir, { recursive: true, force: true }) };
}
