// The example as someone gets it: the workspace packages packed (`npm pack`) and laid into a copy of this folder's
// node_modules, the page built with its own script, host.ts started against the kit's fake Herdr (the only Herdr
// this test ever runs), and a phone-sized headless Chromium going pair → start agent → prompt → receipt → a question
// → answer y → ready again. Every status a person reads must be the kit's own sentence from its words.json.
// Third-party dependencies are linked from the repo's installed tree, so the run stays offline.
// Away from home, a loopback relay with a recording push service stands in for the real ones, and a phone app (plain
// Node here) pairs through it and gets an agent's question sealed: nothing is sent anywhere real.
// BYOKIT_EXAMPLE_SHOTS=<folder> keeps a screenshot of each step, for the README: the computer gets a real name and the
// agent a plausible session (capture-herdr.ts), so the pictures show what a person sees rather than the fake's words.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { herdrDevice } from '@byokit/herdr/device';
import { DeviceLink, pairWithCode } from '@byokit/link';
import { Relay } from '@byokit/relay';
import { findHost } from '@byokit/relay/device';
import { scratchDir, trackChild } from '../../packages/test-support.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../..');
const PACKAGES = ['herdr', 'pair', 'link', 'relay', 'discover', 'reach', 'seal', 'ui-core'];

// A clean copy of the example with the packed packages installed the way npm lays them out.
const dir = scratchDir('herdr-kit');
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
const kitDir = join(modules, '@byokit/herdr/dist');
const WORDS = JSON.parse(readFileSync(join(kitDir, 'words.json'), 'utf8')) as Record<string, string>;
const { writeBinShim } = await import(pathToFileURL(join(kitDir, 'testing/index.js')).href) as typeof import('@byokit/herdr/testing');
const shots = process.env.BYOKIT_EXAMPLE_SHOTS;
const capture = shots ? await import(pathToFileURL(join(app, 'capture-herdr.ts')).href) as typeof import('./capture-herdr.ts') : undefined;
const fakeHerdr = capture ? (mkdirSync(join(dir, 'fake')), capture.writeCaptureShim(join(dir, 'fake')))
  : writeBinShim({ dir: join(dir, 'fake'), socketPath: join(app, '.state/herdr/herdr.sock') });
const NAME = capture ? 'Kitchen computer' : 'Test computer';
const PROMPT = capture?.PROMPT ?? 'hello';
const REPLY = capture?.REPLY ?? 'fake pi: hello';
const QUESTION_PROMPT = capture?.QUESTION_PROMPT ?? 'ask permission';

// Playwright's own Chromium (CI installs it); else the system's, for a machine without Playwright's download.
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath });

// The relay, on loopback. Its push service is this recorder: what Expo would receive, kept here and sent nowhere.
const pushed: { to: string; title?: string; data: { id: string; data?: Record<string, unknown> } }[] = [];
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
const host = trackChild(spawn(process.execPath, ['host.ts', '--herdr', fakeHerdr, '--via', 'lan', '--port', String(port),
  '--name', NAME, '--folder', dir, '--relay', relayAt, `--enrol=${token}`], // `=` form: the token is b64url and may start with `-`
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

const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); };
const text = async (page: Page, selector: string, want: string) => {
  const found = page.locator(selector).filter({ hasText: want }).first();
  await found.waitFor();
  assert.equal((await found.textContent())?.trim(), want);
};

test('pair a phone, start an agent, prompt it, answer its question, all in plain words', async () => {
  await heard(/Connected to Herdr\./);
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
  await text(page, '#pair-title', 'Check your computer shows these two words, then say yes there.');
  await heard(/Pair Android phone\? \(y\/n\) $/);
  await shot(page, '2-compare');
  host.stdin.write('y\n');

  await text(page, '#link', `Connected to ${NAME} - same Wi-Fi.`);
  assert.equal(await page.locator('#herdr').count(), 0, 'one connection line, not two');
  await text(page, '#tree .agent .who', 'project');
  assert.match((await page.locator('#tree .agent .sub').first().textContent()) ?? '',
    new RegExp(`^Pi · ${NAME}$`), 'agent and computer in plain words');
  await text(page, '#agent-name', 'project · Pi');

  // Start a new agent in its own workspace; it becomes the one selected.
  await page.selectOption('#kind', 'pi');
  assert.equal(await page.inputValue('#folder'), dir);
  await page.click('#start-go');
  await page.locator('#tree .agent').nth(1).waitFor();
  const started = page.locator('#tree .agent[aria-pressed="true"]');
  assert.notEqual(await started.getAttribute('data-pane'), 'w1:p2', 'the new agent is selected, not the first one');
  const rows = (await page.locator('#tree .agent').allTextContents()).map((r) => r.trim());
  assert.equal(new Set(rows).size, rows.length, `no two rows read alike: ${JSON.stringify(rows)}`);
  await text(page, '#agent-status', WORDS['agent.idle'].replace(/\.$/, ''));

  // A prompt comes back with Herdr's receipt, and the agent's words show up on its screen.
  await page.fill('#prompt', PROMPT);
  await page.click('#send');
  await text(page, '#receipt', 'Waiting for the reply below.');
  assert.match((await page.locator('#receipt').getAttribute('data-revision'))!, /^\d+$/);
  await page.locator('#screen').filter({ hasText: REPLY }).waitFor();
  await text(page, '#agent-status', WORDS['agent.idle'].replace(/\.$/, ''));
  await shot(page, '3-agent');

  // A question from the agent: it waits for an answer, and y answers it.
  await page.fill('#prompt', QUESTION_PROMPT);
  await page.click('#send');
  const question = page.locator('#blocked .question');
  await question.waitFor();
  await text(page, '#blocked .question p.status', WORDS['agent.blocked']);
  await text(page, '#blocked .question pre', 'Allow this? (y/n)');
  assert.match((await page.locator('#blocked .question h3').textContent()) ?? '',
    /^\S+ · Pi$/, 'the question names its folder and agent in plain words');
  assert.deepEqual(await question.getByRole('button').allTextContents(), ['Allow', 'Deny', 'Skip']);
  await text(page, '#agent-status', WORDS['agent.blocked'].replace(/\.$/, ''));
  await shot(page, '4-question');
  await question.getByRole('button', { name: /^Allow/ }).click();
  await question.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#questions').isHidden(), true);
  await text(page, '#agent-status', WORDS['agent.idle'].replace(/\.$/, ''));
  await shot(page, '5-answered');

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
  await page.fill('#pair-input', 'AAAA-BBBB-CCCC');
  await page.click('#pair-go');
  await text(page, '#pair-error', "That code didn't match. Check it, or show a new one on your computer.");
  await text(page, '#pair-title', 'Scan the code on your computer, or type the code it shows.');
  await page.fill('#pair-input', code);
  await page.click('#pair-go');
  await heard(/\? \(y\/n\) $/, from);
  host.stdin.write('y\n');
  await text(page, '#link', `Connected to ${NAME} - same Wi-Fi.`);
  await page.reload();
  await text(page, '#link', `Connected to ${NAME} - same Wi-Fi.`);
  assert.equal(await page.locator('#herdr').count(), 0, 'one connection line, not two');
  assert.deepEqual(errors, []);
  await context.close();
});

test('adopting a managed session leaves its lifecycle with its owner', async () => {
  await heard(/Connected to Herdr\./);
  const adoptedDir = join(dir, 'adopted');
  mkdirSync(adoptedDir);
  const adoptedPort = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
  const adopted = trackChild(spawn(process.execPath, [join(app, 'host.ts'), '--herdr', fakeHerdr,
    '--socket', join(app, '.state/herdr/herdr.sock'), '--via', 'lan', '--port', String(adoptedPort)],
  { cwd: adoptedDir, env: { ...process.env, BYOKIT_EXAMPLE_FAKE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] }));
  let output = '';
  adopted.stdout.on('data', (b: Buffer) => { output += b.toString(); });
  try {
    for (let i = 0; i < 300 && !output.includes('Connected to Herdr.'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(output, /Connected to Herdr\./);
    assert.equal(existsSync(join(adoptedDir, '.state/herdr')), false, 'adopt mode starts no server');
  } finally {
    const exited = new Promise<void>((resolve) => adopted.once('exit', () => resolve()));
    adopted.kill('SIGTERM');
    await exited;
  }
  // The original owner can still send a real request to the same fake session.
  const { HerdrKit } = await import(pathToFileURL(join(kitDir, 'index.js')).href) as typeof import('@byokit/herdr');
  const probe = new HerdrKit({ mode: 'adopt', bin: fakeHerdr, socketPath: join(app, '.state/herdr/herdr.sock') });
  try {
    await probe.start();
    assert.equal(probe.snapshot().connected, true, 'stopping the example did not stop the managed session');
  } finally { await probe.stop(); }
});

test('away from home: a phone pairs through the relay, and an agent\'s question reaches it sealed', async () => {
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
  const hd = herdrDevice(link);

  // Its notice key (from a seed only the phone keeps) and its push address go to the computer over the link.
  const seed = new Uint8Array(randomBytes(32));
  await hd.registerNotices(seed);
  await link.request('example.push', { expo: 'ExponentPushToken[away-phone]' });

  // An agent asks a question; the push service gets the kit's generic title and an envelope it cannot open.
  const pane = (await hd.tree()).workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.agent)!;
  await hd.prompt(pane.id, QUESTION_PROMPT);
  for (let i = 0; i < 300 && !pushed.length; i++) await new Promise((r) => setTimeout(r, 50));
  const [notice] = pushed;
  assert.ok(notice, 'the relay sent no push');
  const wire = JSON.stringify(notice);
  if (shots) writeFileSync(join(shots, 'relay-wire.json'), `${JSON.stringify(notice, null, 2)}\n`);
  assert.equal(notice.to, 'ExponentPushToken[away-phone]');
  assert.equal(notice.title, WORDS['agent.blocked']);
  // In the clear: the title and the notice's id (its pane; the relay sends each id once). Never the question.
  assert.equal(notice.data.id, pane.id);
  assert.doesNotMatch(wire, /Allow this|ask permission/, 'the relay and push service read only the generic title');
  assert.equal(hd.openNotice(notice.data.data!, new Uint8Array(randomBytes(32))), null, 'another key opens nothing');

  // Only the phone opens it, and answers the question it holds.
  const opened = hd.openNotice(notice.data.data!, seed);
  assert.ok(opened, 'the phone opens its notice');
  assert.equal(opened.paneId, pane.id);
  assert.match(opened.prompt, /Allow this\? \(y\/n\)/);
  await hd.answer(opened.paneId, ['y'], opened.revision);
});
