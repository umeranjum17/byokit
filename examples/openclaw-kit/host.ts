// The computer side of the OpenClaw kit example: the pinned OpenClaw engine in this app's own folder (`./.state`),
// one helper tool that asks before it acts, a link a phone pairs with, and the phone page served on the same port.
// `npm start`; the first start installs the engine (a few minutes).
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OpenClawKit, stateWords, type KitOptions, type ToolHost } from '@byokit/openclaw';
import { openclawLink, serve } from '@byokit/openclaw/link';
import { Host, type Grant, type GrantStore } from '@byokit/link';
import { hostKeyFile } from '@byokit/link/node';
import { RelayClient, type Subscription } from '@byokit/relay';
import { linkUrl } from '@byokit/relay/device';
import type { ServeIngress, Via } from '@byokit/reach';
import { qrMatrix } from '@byokit/ui-core/link';

const { values: flags } = parseArgs({ options: {
  port: { type: 'string', default: '7310' },
  via: { type: 'string', default: 'auto' },             // auto | tailscale | tailscale-direct | private | lan
  name: { type: 'string', default: hostname() },
  relay: { type: 'string' },                            // a relay to reach this computer away from home, e.g. https://relay.example
  enrol: { type: 'string' },                            // the relay owner's one-use enrolment token, first start only
} });
if (flags.relay) flags.relay = flags.relay.replace(/\/+$/, '');

// The only environment read: the e2e test (and a try-out without the engine) runs the kit's fake Gateway.
const fake = process.env.BYOKIT_EXAMPLE_FAKE === '1';
const state = resolve('.state');
mkdirSync(state, { recursive: true, mode: 0o700 });
const notes = join(state, 'notes.txt');

// The one member this app has: every paired device acts for them.
const MEMBER = 'me';

// The helper's one tool: it saves a note on this computer, and asks the person first every time.
const demoNote = {
  name: 'demo_note',
  description: 'Save a short note on this computer.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
};
const tools: ToolHost = {
  // Everything the helper does asks first: this tool, and the engine's own (web search and the like).
  gate: async (_run, tool) => ({ ask: { summary: tool === demoNote.name ? 'save a note' : `use ${tool.replaceAll('_', ' ')}` } }),
  call: async (_run, tool, input) => {
    if (tool !== demoNote.name || typeof input.text !== 'string') return 'Unknown tool.';
    appendFileSync(notes, `${input.text}\n`, { mode: 0o600 });
    return 'Saved.';
  },
};

let said = '';
const options: KitOptions = {
  stateDir: state,
  tools: [demoNote],
  host: tools,
  config: { plugins: { allow: ['openai'] } }, // the plugin of the one route this app signs in with (ChatGPT)
  onState: (s) => {
    const now = stateWords(s);
    if (now && now !== said) console.log(now);
    said = now;
  },
};
const gateway = fake ? await fakeSignIn() : undefined;
if (gateway) Object.assign(options, { spawnEngine: false, transport: gateway.factory });
const kit = new OpenClawKit(options);

// The fake's ChatGPT sign-in, held a few seconds on its code so a person (or the e2e test) can read it.
async function fakeSignIn() {
  const { fakeGateway } = await import('@byokit/openclaw/testing');
  const answered = new Set<string>();
  let signedIn = false;
  return fakeGateway({
    'wizard.next': async (p: { sessionId: string; answer?: unknown }) => {
      if (p.answer) { answered.add(p.sessionId); return { done: false, step: { id: 'step-wait', type: 'progress', executor: 'gateway' } }; }
      if (!answered.has(p.sessionId)) {
        return { done: false, step: { id: 'step-device', type: 'note', executor: 'client',
          deviceCode: { code: 'CREW-2026', expiresInMinutes: 15 }, externalUrl: 'https://auth.openai.com/codex/device' } };
      }
      await delay(3000);
      answered.delete(p.sessionId);
      signedIn = true;
      return { done: true, status: 'done' };
    },
    'wizard.cancel': (p: { sessionId: string }) => { answered.delete(p.sessionId); return { status: 'cancelled' }; },
    'models.authStatus': () => ({ providers: signedIn ? [{ provider: 'openai' }] : [] }),
    'models.authLogout': () => { signedIn = false; return {}; },
  });
}

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
const grantFile = jsonFile<Grant[]>(join(state, 'grants.json'), []);
const grants: GrantStore = grantFile;
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

// SYNTHETIC FIXTURE, fake mode only: the kit's offline browser fake (no Chromium, no profile, no real site) stands in
// for the helper's browser, with one sign-in request already waiting on a loopback address. It shows the sign-in
// card, takeover and live panel end to end; it is not browser protection. Its sign-in pings go out on the fake
// Gateway's event stream, as the kit's own will.
if (fake) {
  const { fakeBrowserHost } = await import('@byokit/openclaw/testing');
  const browser = await fakeBrowserHost({ members: [MEMBER],
    authorize: (grant, member, control) => member === MEMBER && grantFile.load().some((g) => g.id === grant && (!control || g.role === 'control')),
    ping: (member, kind) => gateway?.emit('byokit.browser', { member, kind }) });
  kit.browser = browser;
  await browser.raise({ member: MEMBER, sessionKey: 'agent:me:phone', checkUrl: 'http://127.0.0.1:2820/account',
    reasons: ['password-field'], hints: ['password'] });
  browser.fixture.authenticated(MEMBER, true); // the synthetic site reports signed in once Done is pressed
  const jpeg = new Uint8Array(readFileSync(new URL('fixture-signin.jpg', import.meta.url)));
  setInterval(() => browser.fixture.frame(MEMBER, { seq: Date.now(), at: Date.now(), w: 640, h: 400, jpeg }), 500).unref();
}

// With --relay, each approval also goes to every phone that registered a notice key and a push address, sealed to that
// phone's key: the relay and the push service read only the kit's generic title. The client needs the open host, so
// the kit gets a `notify` that reaches it once it exists (below).
let relay: RelayClient | undefined;
const link = openclawLink(kit, { memberOf: () => MEMBER, ...(flags.relay && { relay: { notify: (n, o) => relay!.notify(n, o) } }) });
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
  // This app's own op: a phone's push address for the relay.
  handle: (req, grant) => req.op === 'example.push' && relay ? relay.subscribe(grant.id, req.args as Subscription) : link.handle(req, grant),
});

// Away from home: the computer dials out to the relay, so it needs no open port, and phones find it by a short code.
// Allow and Deny on a notice come back through the relay to the kit.
if (flags.relay) {
  relay = new RelayClient(host, { url: `${flags.relay.replace(/^http/, 'ws')}/relay/v1/host`, enrol: flags.enrol,
    onAction: link.onAction, onStatus: (s, why) => console.log(`Relay: ${s}${why ? ` (${why})` : ''}`) });
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
  const away = relay ? [linkUrl(flags.relay!, host.id)] : []; // the phone tries this when home is out of reach
  const offer = host.offer({ role: 'control', urls: [...served.urls, ...away], base: page });
  const { code } = host.code({ role: 'control' });
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
