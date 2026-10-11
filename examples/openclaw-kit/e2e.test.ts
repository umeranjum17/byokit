// The example as someone gets it: the workspace packages packed (`npm pack`) and laid into a copy of this folder's
// node_modules, the page built with its own script, host.ts started against the kit's fake Gateway (the only OpenClaw
// this test ever runs), and a phone-sized headless Chromium going pair → sign in with a device code → a message that
// uses the helper's tool → Allow → the reply, then one more → Deny. Every status a person reads must be the kit's own
// sentence from its words.json. Third-party dependencies are linked from the repo's installed tree, so the run stays
// offline. Away from home, a loopback relay with a recording push service stands in for the real ones, and a phone app
// (plain Node here) pairs through it and gets an approval sealed: nothing is sent anywhere real.
// BYOKIT_EXAMPLE_SHOTS=<folder> keeps a screenshot of each step.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { DeviceLink, pairWithCode } from '@byokit/pair';
import { openclawDevice } from '@byokit/openclaw/device';
import { Relay } from '@byokit/relay';
import { findHost } from '@byokit/relay/device';
import { scratchDir, trackChild } from '../../packages/test-support.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../..');
const PACKAGES = ['openclaw', 'pair', 'link', 'relay', 'discover', 'reach', 'seal', 'ui', 'ui-core'];

// A clean copy of the example with the packed packages installed the way npm lays them out.
const dir = scratchDir('openclaw-kit');
const app = join(dir, 'app');
cpSync(here, app, { recursive: true, filter: (f) => !/[/\\](node_modules|\.state|docs)$|app\.js$/.test(f) });
const tgz = join(dir, 'tgz');
mkdirSync(tgz);
const packed = Object.values(JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tgz,
  ...PACKAGES.flatMap((p) => ['-w', `packages/${p}`])], { cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } }))) as { name: string; version: string; filename: string }[]; // an array or keyed by package, by npm version
// The example's pins name exactly what the repo packs, so `npm i` gets the code this test proves.
const pins = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).dependencies as Record<string, string>;
for (const p of packed) if (pins[p.name]) assert.equal(pins[p.name], p.version, `${p.name} pin is stale`);
const modules = join(app, 'node_modules');
for (const p of packed) {
  const into = join(modules, p.name);
  mkdirSync(into, { recursive: true });
  execFileSync('tar', ['-xzf', join(tgz, p.filename), '-C', into, '--strip-components=1']);
}
for (const entry of readdirSync(join(root, 'node_modules'))) {
  if (entry !== '@byokit') symlinkSync(join(root, 'node_modules', entry), join(modules, entry));
}
execFileSync('npm', ['run', 'build:web'], { cwd: app, stdio: 'ignore', env: { ...process.env, npm_config_update_notifier: 'false' } });
const WORDS = JSON.parse(readFileSync(join(modules, '@byokit/openclaw/dist/words.json'), 'utf8')) as Record<string, string>;
const fill = (key: string, vars: Record<string, string>) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), WORDS[key]);
const ASK = fill('approval.ask', { helper: 'Your helper', summary: 'save a note' });
const NAME = 'Test computer';
const shots = process.env.BYOKIT_EXAMPLE_SHOTS;

// Playwright's own Chromium (CI installs it); else the system's, for a machine without Playwright's download.
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath });

// The relay, on loopback. Its push service is this recorder: what Expo would receive, kept here and sent nowhere.
const pushed: { to: string; title?: string; data: { id: string; action?: string; data?: Record<string, unknown> } }[] = [];
const relay = await Relay.open({ push: { fetch: (async (url: string, init: RequestInit) => {
  assert.equal(url, 'https://exp.host/--/api/v2/push/send');
  const messages = JSON.parse(String(init.body));
  pushed.push(...messages);
  return Response.json({ data: messages.map(() => ({ status: 'ok', id: 'x' })) });
}) as typeof fetch } });
const relayServer = httpServer();
relay.attach(relayServer);
await new Promise<void>((r) => relayServer.listen(0, '127.0.0.1', r));
const relayAt = `http://127.0.0.1:${(relayServer.address() as { port: number }).port}`;
const { token } = await relay.enrolment({ name: 'Test computer' });

const port = await new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const host = trackChild(spawn(process.execPath, ['host.ts', '--via', 'lan', '--port', String(port), '--name', NAME,
  '--relay', relayAt, `--enrol=${token}`], // `=` form: the token is b64url and may start with `-`
  { cwd: app, env: { ...process.env, BYOKIT_EXAMPLE_FAKE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] }));
after(async () => { await browser.close(); host.kill('SIGTERM'); relay.close(); relayServer.closeAllConnections(); relayServer.close(); });
let said = '';
host.stdout.on('data', (b: Buffer) => { said += b.toString(); });
/** The host's first line matching `pattern` after `from` characters of what it said. */
const heard = async (pattern: RegExp, from = 0) => {
  for (let i = 0; i < 300 && !pattern.test(said.slice(from)); i++) await new Promise((r) => setTimeout(r, 50));
  const m = said.slice(from).match(pattern);
  assert.ok(m, `host never said ${pattern}; it said:\n${said}`);
  return m;
};
const CODE = /type ([2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4})/;
const notes = () => { try { return readFileSync(join(app, '.state/notes.txt'), 'utf8'); } catch { return ''; } };

const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); };
const text = async (page: Page, selector: string, want: string) => {
  const found = page.locator(selector).filter({ hasText: want }).first();
  await found.waitFor();
  assert.equal((await found.textContent())?.trim(), want);
};

test('pair a phone, sign in with a code, and allow or deny what the helper asks, all in plain words', async () => {
  await heard(new RegExp(WORDS['engine.ready'].replace('.', '\\.')));
  const code = (await heard(CODE))[1];

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => { errors.push(String(e)); console.error(e); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await text(page, '#pair-title', 'Scan the code on your computer, or type the code it shows.');
  await shot(page, '1-pair');

  // The phone and the computer show the same two words; the person says yes at the computer.
  await page.fill('#pair-input', code.toLowerCase());
  await page.click('#pair-go');
  const words = (await heard(/Check it shows these two words: (\w+ \w+)/))[1];
  await text(page, '#pair-words', words);
  await heard(/Pair Android phone\? \(y\/n\) $/);
  host.stdin.write('y\n');

  await text(page, '#link', `Connected to ${NAME}.`);
  await text(page, '#engine', WORDS['engine.ready']);
  await text(page, '#signin-title', fill('member.signedOut', { name: 'ChatGPT' }));
  await shot(page, '2-signed-out');

  // Sign in with ChatGPT: the phone shows the device code and ChatGPT's page; the fake says yes a few seconds later.
  await page.click('#signin-go');
  await text(page, '#signin-code', 'CREW-2026');
  await text(page, '#signin-title', 'On the ChatGPT page, type this code:');
  assert.equal(await page.getAttribute('#signin-url', 'href'), 'https://auth.openai.com/codex/device');
  await shot(page, '3-code');
  await page.locator('#talk').waitFor();
  assert.equal(await page.locator('#signin').isHidden(), true);

  // A message that uses the helper's tool: it waits for a yes, and Allow lets it save the note.
  const allowMe = 'Note this: [tool demo_note {"text":"buy milk"}]';
  await page.fill('#message', allowMe);
  await page.click('#send');
  const approval = page.locator('#approvals .approval');
  await approval.waitFor();
  await text(page, '#approvals .approval p', ASK);
  await text(page, '#tool', 'Using demo note…');
  assert.equal(notes(), '', 'nothing saved before the yes');
  await shot(page, '4-approval');
  await approval.getByRole('button', { name: /^Allow/ }).click();
  await approval.waitFor({ state: 'detached' });
  await text(page, '#reply', `fake: ${allowMe}`);
  assert.equal(await page.locator('#approvals-box').isHidden(), true);
  assert.equal(notes(), 'buy milk\n');
  await shot(page, '5-allowed');

  // Deny: the run still ends, and nothing is saved.
  const denyMe = 'Note this too: [tool demo_note {"text":"not this"}]';
  await page.fill('#message', denyMe);
  await page.click('#send');
  await approval.waitFor();
  await approval.getByRole('button', { name: /^Deny/ }).click();
  await text(page, '#reply', `fake: ${denyMe}`);
  assert.equal(notes(), 'buy milk\n');

  // SYNTHETIC FIXTURE (fake mode): the kit's offline browser fake asks the person to sign in to a loopback site. The
  // card names the address, the first time asks for the site's name, takeover shows the private tab live, and Done
  // puts the chip under the chat. No Chromium profile, real site or model is involved.
  const card = page.locator('#signins .signin');
  await text(page, '#signins .signin-title', fill('signin.title', { site: '127.0.0.1' }));
  await text(page, '#signins .origin', 'http://127.0.0.1:2820');
  await shot(page, 'fixture-6-signin-card');
  await page.fill('#signins input', '127.0.0.1');
  await card.getByRole('button', { name: WORDS['signin.takeover'] }).click();
  await page.locator('#live-box').waitFor();
  await page.waitForFunction(() => { const c = document.querySelector('#live canvas') as HTMLCanvasElement | null; return !!c && c.width === 640; });
  await shot(page, 'fixture-7-live-takeover');
  await page.locator('#signins .signin').getByRole('button', { name: WORDS['signin.done'] }).click();
  await text(page, '#chips .chip', `${fill('signin.verified', { site: '127.0.0.1' })} ✓`);
  assert.equal(await page.locator('#live-box').isHidden(), true);
  assert.equal(await page.locator('#signins-box').isHidden(), true);
  await shot(page, 'fixture-8-signed-in-chip');

  // Signing out brings the sign-in card back with the kit's sentence.
  await page.click('#signout');
  await text(page, '#signin-title', fill('member.signedOut', { name: 'ChatGPT' }));

  assert.deepEqual(errors, []);
  await context.close();
});

test('a page over plain http from the home network keeps its pairing too', async () => {
  // Not a secure context (no sealed store there): the pairing is kept in plain browser storage, across a reload.
  const from = said.length;
  host.stdin.write('\n'); // fresh codes
  const code = (await heard(CODE, from))[1];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => { errors.push(String(e)); console.error(e); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#pair-input', code);
  await page.click('#pair-go');
  await heard(/\? \(y\/n\) $/, from);
  host.stdin.write('y\n');
  await text(page, '#link', `Connected to ${NAME}.`);
  await page.reload();
  await text(page, '#link', `Connected to ${NAME}.`);
  await text(page, '#engine', WORDS['engine.ready']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('away from home: a phone pairs through the relay, gets an approval sealed, and Allow on it comes back', async () => {
  // The phone app finds the computer by the relay's short code, then pairs with the link code, as in the README.
  await heard(/Away from home: online/);
  const from = said.length;
  host.stdin.write('\n'); // fresh codes
  const code = (await heard(CODE, from))[1];
  const short = (await heard(/find this computer at \S+ with (\S+)/, from))[1];
  const pairing = pairWithCode(await findHost(relayAt, short), code, { name: 'Away phone', onWords: () => {} });
  await heard(/Pair Away phone\? \(y\/n\) $/, from);
  host.stdin.write('y\n');
  const link = new DeviceLink(await pairing);
  after(() => link.stop());
  const oc = openclawDevice(link);

  // Its notice key (from a seed only the phone keeps) and its push address go to the computer over the link.
  const seed = new Uint8Array(randomBytes(32));
  await oc.registerNotices(seed);
  await link.request('example.push', { expo: 'ExponentPushToken[away-phone]' });

  // Signed in (the fake's code sign-in), a message that uses the tool waits for a yes, and the yes is asked by push.
  await oc.signIn.start('openai', 'code');
  for (let i = 0; i < 200 && !(await oc.signIn.view('openai')).ready; i++) await new Promise((r) => setTimeout(r, 50));
  const ask = 'Note this: [tool demo_note {"text":"from away"}]';
  const reply = (async () => { for await (const e of oc.run(ask)) if (e.type === 'end') return e; })();
  // The run raises the approval, the kit pushes it, and the relay hands it to the recorder: a full boot and stream on a
  // loaded runner. Wait for the approval to exist before bounding the wait for its push, so a slow run is not mistaken
  // for a missing push.
  const approvalDeadline = Date.now() + 60_000;
  while ((await oc.approvals()).length === 0 && Date.now() < approvalDeadline) await new Promise((r) => setTimeout(r, 50));
  const pushDeadline = Date.now() + 30_000;
  while (!pushed.length && Date.now() < pushDeadline) await new Promise((r) => setTimeout(r, 50));
  const [notice] = pushed;
  assert.ok(notice, `the relay sent no push; approvals waiting: ${(await oc.approvals()).length}\nhost said:\n${said}`);
  const wire = JSON.stringify(notice);
  if (shots) writeFileSync(join(shots, 'relay-wire.json'), `${JSON.stringify(notice, null, 2)}\n`);

  // The push service gets the kit's generic title and an envelope it cannot open; in the clear too: the approval's id
  // (the relay sends each id once) and the one-use token for its buttons. Never what is being asked.
  assert.equal(notice.to, 'ExponentPushToken[away-phone]');
  assert.equal(notice.title, WORDS['approval.notice']);
  assert.doesNotMatch(wire, /from away|save a note|demo_note/, 'the relay and push service read only the generic title');
  assert.equal(oc.openNotice(notice.data.data!, new Uint8Array(randomBytes(32))), null, 'another key opens nothing');
  const opened = oc.openNotice(notice.data.data!, seed);
  assert.ok(opened, 'the phone opens its notice');
  assert.equal(opened.id, notice.data.id);
  assert.equal(opened.summary, 'save a note');
  assert.equal(notes().includes('from away'), false, 'nothing saved before the yes');

  // Allow, pressed on the notice: the relay hands it to the computer, which lets the tool run.
  const pressed = await fetch(`${relayAt}/relay/v1/push/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: notice.data.action, action: 'allow' }) });
  assert.equal(pressed.status, 200, await pressed.clone().text());
  assert.equal((await reply)?.type, 'end');
  assert.match(notes(), /from away\n$/);
});
