// The computer side of the Herdr kit example: Herdr in this app's own folder (`./.state`), a link a phone pairs with,
// and the phone page served on the same port. `npm start -- --herdr "$(command -v herdr)" --path "$PATH"`.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HerdrKit, stateWords } from '@byokit/herdr';
import { herdrLink, serve } from '@byokit/herdr/link';
import { Host, type Grant, type GrantStore } from '@byokit/link';
import { hostKeyFile } from '@byokit/link/node';
import type { ServeIngress, Via } from '@byokit/reach';
import { qrMatrix } from '@byokit/ui-core/link';

const { values: flags } = parseArgs({ options: {
  herdr: { type: 'string' },                            // the Herdr program, as a full path
  path: { type: 'string' },                             // where Herdr's panes look for agent programs
  folder: { type: 'string', default: process.cwd() },   // where new agents start
  port: { type: 'string', default: '7310' },
  via: { type: 'string', default: 'auto' },             // auto | tailscale | tailscale-direct | private | lan
  name: { type: 'string', default: hostname() },
} });

// The only environment read: the e2e test (and a try-out without Herdr) runs the kit's fake Herdr.
const fake = process.env.BYOKIT_EXAMPLE_FAKE === '1';
const state = resolve('.state');
mkdirSync(state, { recursive: true, mode: 0o700 });

let bin = flags.herdr;
if (fake && !bin) {
  const { writeBinShim } = await import('@byokit/herdr/testing');
  bin = writeBinShim({ dir: join(state, 'fake-herdr'), socketPath: join(state, 'herdr', 'herdr.sock') });
}
if (!bin || !isAbsolute(bin)) {
  console.error('Give the Herdr program as a full path: npm start -- --herdr "$(command -v herdr)" --path "$PATH"');
  process.exit(2);
}
const path = flags.path?.split(':').filter(Boolean) ?? [dirname(bin), '/usr/local/bin', '/usr/bin', '/bin'];

const kit = new HerdrKit({ mode: 'own', bin, stateDir: state, path, onState: (s) => { if (s.phase !== 'stopped') console.log(stateWords(s)); } });

// Paired devices, kept across restarts (0600, written whole then renamed into place).
const jsonFile = <T>(file: string, empty: T) => ({
  load: (): T => {
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty; throw e; }
  },
  save: (value: T) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  },
});
const grants: GrantStore = jsonFile<Grant[]>(join(state, 'grants.json'), []);
const ingress = jsonFile<ServeIngress | null>(join(state, 'ingress.json'), null);

// Pairing asks the person here; answers come in order, and an Enter with no question pending shows fresh codes.
const input = createInterface({ input: process.stdin });
const answers: ((line: string) => void)[] = [];
input.on('line', (line) => { const answer = answers.shift(); if (answer) answer(line); else showCodes(); });
input.on('close', () => { for (const answer of answers.splice(0)) answer(''); });

// Every device paired here sees all of Herdr (`meta.scope` below); a grant without a scope sees nothing.
const link = herdrLink(kit, { scopeOf: (g) => (g.meta as { scope?: { workspaces: 'all' | string[] } } | undefined)?.scope ?? { workspaces: [] } });
const host = await Host.open({
  keys: hostKeyFile(join(state, 'link-key.json')),
  name: flags.name,
  grants,
  confirm: async (p) => {
    console.log(`\n${p.name} wants to pair. Check it shows these two words: ${p.words}`);
    process.stdout.write(`Pair ${p.name}? (y/n) `);
    const yes = /^y(es)?$/i.test((await new Promise<string>((r) => answers.push(r))).trim());
    console.log(yes ? `${p.name} is paired.` : `${p.name} was turned away.`);
    return yes;
  },
  ...link,
  // One question of this app's own for its start-agent form: the kinds Herdr knows and the folder agents start in.
  handle: async (req, grant) => req.op === 'example.setup'
    ? { kinds: await kit.agentKinds().catch(() => []), folder: resolve(flags.folder) }
    : link.handle(req, grant),
});

// The phone page: index.html and the bundled app.js (`npm run build:web`), nothing else.
const web = fileURLToPath(new URL('web/', import.meta.url));
const PAGES: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'] };
const http = (req: IncomingMessage, res: ServerResponse) => {
  const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
  if (!page) { res.writeHead(404).end(); return; }
  let body: Buffer;
  try { body = readFileSync(join(web, page[0])); } catch { res.writeHead(500).end('Run npm run build:web first.'); return; }
  res.writeHead(200, {
    'content-type': `${page[1]}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  }).end(body);
};

const served = await serve({ host, port: Number(flags.port), via: flags.via as Via, previous: ingress.load() ?? undefined, http });
ingress.save(served.ingress ?? null);
const page = served.urls[0].replace(/^ws/, 'http').replace(/\/?$/, '/');

// A QR for the phone's camera: two rows of modules per line of text, dark on light whatever the terminal's colours.
function terminalQr(text: string): string {
  const m = qrMatrix(text);
  const rows: string[] = [];
  for (let y = 0; y < m.length; y += 2) {
    rows.push(m[y].map((top, x) => `\x1b[${top ? 30 : 97}m\x1b[${m[y + 1]?.[x] ? 40 : 107}m▀`).join('') + '\x1b[0m');
  }
  return rows.join('\n');
}

function showCodes() {
  const terms = { role: 'control' as const, meta: { scope: { workspaces: 'all' } } };
  const offer = host.offer({ ...terms, urls: served.urls, base: page });
  const { code } = host.code(terms);
  console.log(`\n${terminalQr(offer.text)}\n\nOn the phone, scan this, or open ${page} and type ${code}`);
  console.log('Codes last five minutes. Press Enter for new ones.');
}

showCodes();
kit.start().catch(() => {}); // a failed start is already said in words above; the page shows it too

const stop = async () => {
  input.close();
  await kit.stop().catch(() => {});
  host.close();
  await served.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
