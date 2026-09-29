#!/usr/bin/env node
// `compose` — the agent CLI (docs/capability-kits.md 4.6): TOON or `key: value` output, `error:` lines on stderr,
// exit 0 pass / 1 a draft fails / 2 usage / 3 engine missing or needs-update / 4 other engine failure.
// Reads only the files named on its command line; no env, no writes, no network. The body lands in BK-P1.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Engine } from './types.ts';

export type CliIo = {
  engine?: Engine;
  stdout(s: string): void;
  stderr(s: string): void;
  readFile(path: string): string;
};

export async function main(argv: string[], io: CliIo): Promise<number> {
  void argv;
  io.stderr('error: not built: BK-P1\n');
  return 4;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  const io: CliIo = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readFile: () => { throw new Error('not built: BK-P1'); },
  };
  main(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
