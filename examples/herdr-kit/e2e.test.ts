// The example as someone gets it: the workspace packages packed (`npm pack`) and laid into a copy of this folder's
// node_modules, the page built with its own script, host.ts started against the kit's fake Herdr (the only Herdr
// this test ever runs), and a phone-sized headless Chromium going pair → start agent → prompt → receipt → a question
// → answer y → ready again. Every status a person reads must be the kit's own sentence from its words.json.
// Third-party dependencies are linked from the repo's installed tree, so the run stays offline.
// BYOKIT_EXAMPLE_SHOTS=<folder> keeps a screenshot of each step.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { scratchDir, trackChild } from '../../packages/test-support.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../..');
const PACKAGES = ['herdr', 'link', 'relay', 'reach', 'seal', 'ui-core'];

// A clean copy of the example with the packed packages installed the way npm lays them out.
const dir = scratchDir('herdr-kit');
const app = join(dir, 'app');
cpSync(here, app, { recursive: true, filter: (f) => !/[/\\](node_modules|\.state|docs)$|app\.js$/.test(f) });
const tgz = join(dir, 'tgz');
mkdirSync(tgz);
const packed = Object.values(JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tgz,
  ...PACKAGES.flatMap((p) => ['-w', `packages/${p}`])], { cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } }))) as { name: string; filename: string }[]; // an array or keyed by package, by npm version
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
const fakeHerdr = writeBinShim({ dir: join(dir, 'fake'), socketPath: join(app, '.state/herdr/herdr.sock') });

const port = await new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const host = trackChild(spawn(process.execPath, ['host.ts', '--herdr', fakeHerdr, '--via', 'lan', '--port', String(port),
  '--name', 'Test computer', '--folder', dir], { cwd: app, env: { ...process.env, BYOKIT_EXAMPLE_FAKE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] }));
let said = '';
host.stdout.on('data', (b: Buffer) => { said += b.toString(); });
const heard = async (pattern: RegExp) => {
  for (let i = 0; i < 300 && !pattern.test(said); i++) await new Promise((r) => setTimeout(r, 50));
  const m = said.match(pattern);
  assert.ok(m, `host never said ${pattern}; it said:\n${said}`);
  return m;
};

// Playwright's own Chromium (CI installs it); else the system's, for a machine without Playwright's download.
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath });
after(async () => { await browser.close(); host.kill('SIGTERM'); });

const shots = process.env.BYOKIT_EXAMPLE_SHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); };
const text = async (page: Page, selector: string, want: string) => {
  const found = page.locator(selector).filter({ hasText: want }).first();
  await found.waitFor();
  assert.equal((await found.textContent())?.trim(), want);
};

test('pair a phone, start an agent, prompt it, answer its question, all in plain words', async () => {
  await heard(/Connected to Herdr\./);
  const code = (await heard(/type ([2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4})/))[1];

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

  await text(page, '#link', 'Connected to Test computer.');
  await text(page, '#herdr', WORDS['herdr.ready']);
  await text(page, '#tree .agent', `pi${WORDS['agent.idle']}`);

  // Start a new agent in its own workspace; it becomes the one selected.
  await page.click('#start summary');
  await page.selectOption('#kind', 'pi');
  assert.equal(await page.inputValue('#folder'), dir);
  await page.click('#start-go');
  await page.locator('#tree .agent').nth(1).waitFor();
  const started = page.locator('#tree .agent[aria-pressed="true"]');
  assert.notEqual(await started.getAttribute('data-pane'), 'w1:p2', 'the new agent is selected, not the first one');
  await text(page, '#agent-status', WORDS['agent.idle']);

  // A prompt comes back with Herdr's receipt, and the agent's words show up on its screen.
  await page.fill('#prompt', 'hello');
  await page.click('#send');
  await text(page, '#receipt', 'Sent.');
  assert.match((await page.locator('#receipt').getAttribute('data-revision'))!, /^\d+$/);
  await page.locator('#screen').filter({ hasText: 'fake pi: hello' }).waitFor();
  await text(page, '#agent-status', WORDS['agent.idle']);
  await shot(page, '3-agent');

  // A question from the agent: it waits for an answer, and y answers it.
  await page.fill('#prompt', 'ask permission');
  await page.click('#send');
  const question = page.locator('#blocked .question');
  await question.waitFor();
  await text(page, '#blocked .question p.status', WORDS['agent.blocked']);
  await text(page, '#blocked .question pre', 'Allow this? (y/n)');
  await text(page, '#agent-status', WORDS['agent.blocked']);
  await shot(page, '4-question');
  await question.getByRole('button', { name: /^Answer y/ }).click();
  await question.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#questions').isHidden(), true);
  await text(page, '#agent-status', WORDS['agent.idle']);
  await shot(page, '5-answered');

  assert.deepEqual(errors, []);
  await context.close();
});
