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
import { RelayClient, type Subscription } from '@byokit/relay';
import { linkUrl } from '@byokit/relay/device';
import type { ServeIngress, Via } from '@byokit/reach';
import { qrMatrix } from '@byokit/ui-core/link';

const { values: flags } = parseArgs({ options: {
  herdr: { type: 'string' },                            // the Herdr program, as a full path
  socket: { type: 'string' },                           // connect to an explicitly managed Herdr session
  path: { type: 'string' },                             // where Herdr's panes look for agent programs
  folder: { type: 'string', default: process.cwd() },   // where new agents start
  port: { type: 'string', default: '7310' },
  via: { type: 'string', default: 'auto' },             // auto | tailscale | tailscale-direct | private | lan
  name: { type: 'string', default: hostname() },
  relay: { type: 'string' },                            // a relay to reach this computer away from home, e.g. https://relay.example
  enrol: { type: 'string' },                            // the relay owner's one-use enrolment token, first start only
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
if (flags.socket && !isAbsolute(flags.socket)) {
  console.error('Give the managed session socket as a full path: --socket <absolute path>');
  process.exit(2);
}

let said = '';
const kit = new HerdrKit({ ...(flags.socket
  ? { mode: 'adopt' as const, socketPath: flags.socket }
  : { mode: 'own' as const, stateDir: state }), bin, path, onState: (s) => {
  const now = stateWords(s);
  if (now && now !== said) console.log(now);
  said = now;
} });

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

// Pairing asks the person here, one device at a time: a second one asking meanwhile is turned away, and a question
// nobody answers ends with the pairing window. An Enter with no question open shows fresh codes.
const input = createInterface({ input: process.stdin });
let asking: ((line: string) => void) | undefined;
let closed = false;
input.on('line', (line) => { const answer = asking; asking = undefined; if (answer) answer(line); else showCodes(); });
input.on('close', () => { closed = true; asking?.(''); });
const ask = (question: string) => new Promise<string>((resolve) => {
  process.stdout.write(question);
  const answer = (line: string) => { clearTimeout(timer); if (asking === answer) asking = undefined; resolve(line); };
  const timer = setTimeout(() => { console.log(''); answer(''); }, 300_000);
  asking = answer;
});

// Every device paired here sees all of Herdr (`meta.scope` below); a grant without a scope sees nothing.
// With --relay, each question an agent asks also goes to every phone that registered a notice key and a push address,
// sealed to that phone's key: the relay and the push service read only the kit's generic title. The client needs the
// open host, so the kit gets a `notify` that reaches it once it exists (below).
let relay: RelayClient | undefined;
const link = herdrLink(kit, {
  scopeOf: (g) => (g.meta as { scope?: { workspaces: 'all' | string[] } } | undefined)?.scope ?? { workspaces: [] },
  ...(flags.relay && { relay: { notify: (n, o) => relay!.notify(n, o) } }),
});
const host = await Host.open({
  keys: hostKeyFile(join(state, 'link-key.json')),
  name: flags.name,
  grants,
  confirm: async (p) => {
    if (closed || asking) {
      console.log(`\n${p.name} wants to pair, but ${closed ? 'nobody can answer here' : 'another device is waiting'}: turned away.`);
      return false;
    }
    console.log(`\n${p.name} wants to pair. Check it shows these two words: ${p.words}`);
    const yes = /^y(es)?$/i.test((await ask(`Pair ${p.name}? (y/n) `)).trim());
    console.log(yes ? `${p.name} is paired.` : `${p.name} was turned away.`);
    return yes;
  },
  ...link,
  // This app's own ops: its start-agent form's kinds and folder, and a phone's push address for the relay.
  handle: async (req, grant) => req.op === 'example.setup'
    ? { kinds: await kit.agentKinds().catch(() => []), folder: resolve(flags.folder) }
    : req.op === 'example.push' && relay ? relay.subscribe(grant.id, req.args as Subscription)
    : link.handle(req, grant),
});

// Away from home: the computer dials out to the relay, so it needs no open port, and phones find it by a short code.
if (flags.relay) {
  relay = new RelayClient(host, { url: `${flags.relay.replace(/^http/, 'ws')}/relay/v1/host`, enrol: flags.enrol,
    onStatus: (s, why) => console.log(`Relay: ${s}${why ? ` (${why})` : ''}`) });
}

// Explicit static shell and icon routes; never serve arbitrary files from the host.
const web = fileURLToPath(new URL('web/', import.meta.url));
const PAGES: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
};
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
  const away = relay ? [linkUrl(flags.relay!, host.id)] : []; // the phone tries this when home is out of reach
  const offer = host.offer({ ...terms, urls: [...served.urls, ...away], base: page });
  const { code } = host.code(terms);
  console.log(`\n${terminalQr(offer.text)}\n\nOn the phone, scan this, or open ${page} and type ${code}`);
  relay?.code().then((r) => console.log(`Away from home, find this computer at ${flags.relay} with ${r.code}`), () => {});
  console.log('Codes last five minutes. Press Enter for new ones.');
}

showCodes();
kit.start().catch(() => {}); // a failed start is already said in words above; the page shows it too

const stop = async () => {
  input.close();
  await kit.stop().catch(() => {});
  relay?.stop();
  host.close();
  await served.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
