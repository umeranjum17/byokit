// For the README pictures only (e2e.test.ts with BYOKIT_EXAMPLE_SHOTS): the kit's fake Herdr behind a socket that
// makes its agent's screen read like a real session. The fake answers a prompt with `fake pi: <prompt>` and asks
// its question on `ask permission`; this maps the pictured prompts onto those and the fake's lines onto a plausible
// transcript. Nothing else changes: every other request and answer passes through untouched.
import { chmodSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fakeHerdrBinMain, startFakeHerdr } from '@byokit/herdr/testing';

export const PROMPT = 'Add a --json flag to export';
export const QUESTION_PROMPT = 'Run the tests';
const ASKS: Record<string, string> = { [QUESTION_PROMPT]: 'ask permission' };
const SCREEN: Record<string, string[]> = {
  'ready.': [],
  [`fake pi: ${PROMPT}`]: [`> ${PROMPT}`, 'Read src/cli/export.ts', 'Edited src/cli/export.ts +18 -3',
    'export --json now prints JSON.'],
  'Allow this? (y/n)': [`> ${QUESTION_PROMPT}`, 'Run npm test in ~/code/shop?', 'Allow this? (y/n)'],
  y: ['y', 'npm test: 42 passing'],
};
export const REPLY = SCREEN[`fake pi: ${PROMPT}`][3];

/** A Herdr program for the kit: this file, run by the current Node. */
export function writeCaptureShim(dir: string): string {
  const bin = join(dir, 'herdr');
  writeFileSync(bin, `#!${process.execPath}\nimport(${JSON.stringify(import.meta.url)}).then((m) => m.main(process.argv.slice(2)));\n`);
  chmodSync(bin, 0o700);
  return bin;
}

export async function main(argv: string[]): Promise<void> {
  if (argv[0] !== 'server') return fakeHerdrBinMain(argv);
  const outer = process.env.HERDR_SOCKET_PATH!;
  const inner = join(dirname(outer), 'fake.sock');
  const fake = await startFakeHerdr({ dir: dirname(outer), socketPath: inner });
  const proxy = createServer((client) => {
    const upstream = createConnection(inner);
    let head = '';
    let rewrite = false;
    const fromClient = (chunk: Buffer) => {
      head += chunk.toString('utf8');
      const nl = head.indexOf('\n');
      if (nl < 0) return;
      client.off('data', fromClient);
      client.pipe(upstream);
      const request = JSON.parse(head.slice(0, nl)) as { method: string; params: Record<string, unknown> };
      if (request.method === 'agent.prompt') request.params.text = ASKS[request.params.text as string] ?? request.params.text;
      rewrite = request.method === 'pane.read' && request.params.source !== 'detection';
      upstream.write(`${JSON.stringify(request)}\n${head.slice(nl + 1)}`);
      if (!rewrite) upstream.pipe(client);
    };
    client.on('data', fromClient);
    let answer = '';
    upstream.on('data', (chunk: Buffer) => {
      if (!rewrite) return;
      answer += chunk.toString('utf8');
      if (!answer.includes('\n')) return;
      const message = JSON.parse(answer);
      const read = message.result?.read;
      if (read) read.text = (read.text as string).split('\n').flatMap((line) => SCREEN[line] ?? [line]).join('\n');
      client.end(`${JSON.stringify(message)}\n`);
    });
    upstream.on('close', () => client.end());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(outer, resolve));
  const stop = () => { proxy.close(); void fake.stop().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
