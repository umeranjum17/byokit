// The example as someone gets it: the workspace packages packed (`npm pack`) and laid into a copy of this folder's
// node_modules, the page built with its own script, host.ts started against the kit's fake Gateway (the only OpenClaw
// this test ever runs), and a phone-sized headless Chromium going pair → the kit's routes, grouped → sign in from the
// ChatGPT plan row with a device code → a message that uses the helper's tool → Allow → the reply, then one more → Deny,
// then the OpenCode Go plan's key pasted on the phone → a reply with its usage.
// Every status a person reads must be the kit's own sentence from its words.json. Third-party dependencies are linked
// from the repo's installed tree, so the run stays offline. Away from home, a loopback relay with a recording push
// service stands in for the real ones, and a phone app (plain Node here) pairs through it and gets an approval sealed:
// nothing is sent anywhere real.
// BYOKIT_EXAMPLE_SHOTS=<folder> keeps a light and a dark screenshot of each step.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
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
const PACKAGES = ['openclaw', 'accounts', 'usage', 'secrets', 'pair', 'link', 'relay', 'discover', 'reach', 'seal', 'ui', 'ui-core'];

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
  { cwd: app, env: { ...process.env, BYOKIT_EXAMPLE_FAKE: '1', BYOKIT_EXAMPLE_ORGS: 'multi' }, stdio: ['pipe', 'pipe', 'inherit'] }));
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

const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  // Reduced motion too, so no colour transition is caught half way.
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.screenshot({ path: join(shots, `${name}.dark.png`), fullPage: true });
  await page.emulateMedia({ colorScheme: null, reducedMotion: null });
};
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

  // Every route the kit lists, grouped by @byokit/ui's connectView: Plans first and open, the rest folded. Only a ready
  // code sign-in is a button here; a page sign-in (it returns to the computer), a key and an app the computer lacks
  // stay listed with why.
  await page.locator('#routes details').first().waitFor(); // drawn all at once
  const groups = await page.locator('#routes details').evaluateAll((ds) => ds.map((d) => [d.dataset.group, (d as HTMLDetailsElement).open]));
  assert.deepEqual(groups[0], ['plans', true]);
  assert.ok(groups.length > 2 && groups.slice(1).every(([, open]) => !open), JSON.stringify(groups));
  const row = (id: string) => page.locator(`#routes [data-route="${id}"]`);
  const chatgpt = row('openai:code:openai-device-code');
  assert.deepEqual(await chatgpt.locator('span').allTextContents(), ['Codex login (device code) — sign in with a code', 'Uses your OpenAI plan', 'Ready']);
  assert.equal(await chatgpt.getAttribute('aria-disabled'), null);
  for (const [id, why] of [['openai:browser:openai', 'Ready, but this page has no form for it yet.'],
    ['github-copilot:code:github-copilot-enterprise', 'Ready. This computer starts only the first sign-in for this provider.'],
    ['anthropic:cli:anthropic-cli', 'Install its app on this computer first.']]) {
    assert.equal(await row(id).getAttribute('aria-disabled'), 'true', id);
    assert.equal(await row(id).locator('.status').textContent(), why, id);
  }
  assert.equal(await row('openai:key:openai-api-key').locator('xpath=ancestor::details').getAttribute('data-group'), 'perUse');
  // Listed, not startable: nothing happens. A start would name its account in the card within a refresh (1s).
  await row('openai:browser:openai').click({ force: true });
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#signin-title').textContent(), '');
  assert.equal(await page.locator('#signin-code').isHidden(), true);
  await shot(page, '2-signed-out');

  // Sign in from the ChatGPT plan row: the phone shows the device code and the provider's page; the fake says yes a few
  // seconds later.
  await chatgpt.click();
  await text(page, '#signin-code', 'CREW-2026');
  await text(page, '#signin-title', 'On the Codex login (device code) page, type this code:');
  assert.equal(await page.locator('#routes').isHidden(), true);
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
  // The run's end carries the engine's totals, and the page shows them under the reply.
  const usage = page.locator('#usage').filter({ hasText: /^Tokens:/ });
  await usage.waitFor();
  assert.match(await usage.textContent() ?? '', /^Tokens: \d+ in, \d+ out, \d+ total(, on \S+)?\.$/);
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

  // A reload names the provider it is signed in to, and signing out brings the ways in back with that provider's sentence.
  await page.reload();
  await page.locator('#talk').waitFor();
  await text(page, '#signout', 'Sign out of OpenAI');
  await page.click('#signout');
  await text(page, '#signin-title', fill('member.signedOut', { name: 'OpenAI' }));
  await chatgpt.waitFor();

  // The OpenCode Go plan: the phone pastes the key from the plan into the kit's `Plan key` prompt, and the computer
  // keeps and checks it. This key acts for two workspaces, so the phone is asked which one and answers through the
  // same hidden paste. A refused key shows only the kit's sentence; the key is never shown back or said.
  const go = row('opencode-go:plan_key:opencode-go');
  assert.equal(await go.getAttribute('aria-disabled'), null);
  await go.click();
  await text(page, '#signin-key-label', 'Plan key');
  await text(page, '#signin-title', 'Paste the key from your plan. Your computer keeps it, not this phone.');
  assert.equal(await page.getAttribute('#signin-key-input', 'type'), 'password');
  assert.equal(await page.locator('#routes').isHidden(), true);
  await shot(page, '9-plan-key');
  await page.fill('#signin-key-input', 'wrong-key');
  await page.click('#signin-key-go');
  await text(page, '#signin-key-label', 'Which workspace? Paste one of: Default, Working2');
  await page.fill('#signin-key-input', 'Working2');
  await page.click('#signin-key-go');
  await text(page, '#signin-title', 'API key activation failed');
  const KEY = 'sk-go-CANARY-PHONE-PASTE-7731';
  await go.click();
  await page.fill('#signin-key-input', KEY);
  await page.click('#signin-key-go');
  await text(page, '#signin-key-label', 'Which workspace? Paste one of: Default, Working2');
  await page.fill('#signin-key-input', 'Working2');
  await page.click('#signin-key-go');
  await page.locator('#talk').waitFor();
  await page.fill('#message', 'Hello Go');
  await page.click('#send');
  await text(page, '#reply', 'fake: Hello Go');
  await page.locator('#usage').filter({ hasText: /^Tokens: \d+ in, \d+ out, \d+ total(, on \S+)?\.$/ }).waitFor(); // with the end, after the text
  await shot(page, '10-plan-key-answered');
  assert.equal((await page.content()).includes(KEY), false, 'the page keeps no key');
  assert.equal(said.includes(KEY), false, 'the computer never says the key');

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
  // Awaited below; this only keeps a failure before then from leaking the run's rejection (LinkRefused at link.stop)
  // past the test's end.
  reply.catch(() => {});
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

// The hidden plan-key prompt runs only on a terminal: these hosts get a pty through `script`, with the kit's fake
// Gateway (no engine, no account, no network). `heard` waits for the first match of `pattern` in what the host said
// after `from` characters; `said` is everything it has said so far.
async function ptyHost(dir: string, folder: string, name: string) {
  const at = join(dir, folder);
  cpSync(app, at, { recursive: true, filter: (f) => !/[/\\]\.state$/.test(f) });
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
  const pty = trackChild(spawn('script', ['-qec', `node host.ts --via lan --port ${port} --name ${name}`, '/dev/null'],
    { cwd: at, env: { ...process.env, BYOKIT_EXAMPLE_FAKE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] }));
  let said = '';
  pty.stdout.on('data', (b: Buffer) => { said += b.toString(); });
  const heard = async (pattern: RegExp, from = 0) => {
    for (let i = 0; i < 300 && !pattern.test(said.slice(from)); i++) await new Promise((r) => setTimeout(r, 50));
    const m = said.slice(from).match(pattern);
    assert.ok(m, `pty host never said ${pattern}; it said:\n${said}`);
    return m;
  };
  await heard(new RegExp(WORDS['engine.ready'].replace('.', '\\.'))).catch(error => { pty.kill('SIGTERM'); throw error; });
  return { pty, heard, said: () => said };
}
/** A pty host's exit code, or null when it is still running after `ms`. */
const exitWithin = (pty: ChildProcess, ms: number) => new Promise<number | null>((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  pty.once('exit', (c) => { clearTimeout(timer); resolve(c); });
});

test('a key typed while the terminal is hidden is neither echoed nor run', async () => {
  // Bytes written in the same breath as the prompt's Enter arrive while input is still hidden, so showInput must
  // drop them instead of echoing or running them as commands.
  const { pty, heard, said } = await ptyHost(dir, 'pty-hidden', 'Pty');
  try {
    // A failed add: an empty paste cancels it, and the key bytes in the same breath must be dropped.
    let mark = said().length;
    pty.stdin.write('add opencode-go\n');
    await heard(/Paste the/, mark);
    const CANARY = 'sk-go-CANARY-HIDDEN-5521';
    mark = said().length;
    pty.stdin.write('\n');
    pty.stdin.write(`${CANARY}\n`);
    await heard(/Cancelled\./, mark);
    await new Promise((r) => setTimeout(r, 1500));
    assert.doesNotMatch(said(), new RegExp(CANARY), 'the typed key is never echoed');
    assert.equal((said().slice(mark).match(CODE) ?? []).length, 0, 'the typed Enter shows no fresh codes');
    // A signed-in add: trailing bytes past the paste meet the same drop.
    mark = said().length;
    pty.stdin.write('add opencode-go\n');
    await heard(/Paste the/, mark);
    const TRAIL = 'sk-go-CANARY-TRAIL-5522';
    mark = said().length;
    pty.stdin.write('sk-go-CANARY-SIGNED-IN-9\n');
    pty.stdin.write(`${TRAIL}\n`);
    await heard(/Signed in to/, mark);
    await new Promise((r) => setTimeout(r, 1500));
    assert.doesNotMatch(said(), new RegExp('CANARY-TRAIL'), 'trailing bytes are never echoed');
    assert.equal((said().slice(mark).match(CODE) ?? []).length, 0, 'trailing bytes run no command');
  } finally {
    pty.kill('SIGTERM');
  }
});

test('Ctrl-C during a hidden plan-key sign-in quits', async () => {
  // While raw mode hides the terminal, Ctrl-C arrives as a byte, not SIGINT: the host stops like it does outside.
  const { pty, heard } = await ptyHost(dir, 'pty-quit', 'PtyQuit');
  try {
    pty.stdin.write('add opencode-go\n');
    await heard(/Paste the/);
    pty.stdin.write(String.fromCharCode(3)); // Ctrl-C while hidden: quit, the same as SIGINT
    assert.equal(await exitWithin(pty, 15000), 0, 'the host quits on Ctrl-C during a hidden sign-in');
  } finally {
    pty.kill('SIGTERM');
  }
});

test('Ctrl-C after the plan key is pasted quits while the sign-in still settles', async () => {
  // The computer checks the pasted key for a few seconds (the fake's SETTLE_MS, as the engine's restart does) with
  // the terminal still hidden, so a Ctrl-C there arrives as a byte too: it must quit at once, not once the check
  // ends and the terminal is back.
  const { pty, heard, said } = await ptyHost(dir, 'pty-settle', 'PtySettle');
  try {
    const from = said().length;
    pty.stdin.write('add opencode-go\n');
    await heard(/Paste the/, from);
    pty.stdin.write('sk-go-CANARY-SETTLING-5523\n');
    await new Promise((r) => setTimeout(r, 500)); // the check is under way, and has said nothing yet
    pty.stdin.write(String.fromCharCode(3));
    assert.equal(await exitWithin(pty, 5000), 0, 'the host quits on Ctrl-C while the key check runs');
    assert.doesNotMatch(said(), /Signed in to/, 'it quit before the check ended');
  } finally {
    pty.kill('SIGTERM');
  }
});
