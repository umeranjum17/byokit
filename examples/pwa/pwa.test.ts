// "Sign in with ChatGPT" in a real browser (headless Chromium through Playwright), end to end against the stand-in
// OpenAI on another origin, as a person does it: the code on the page, typed on the provider's page in another tab,
// kept in IndexedDB across a reload, signed out (revoked there). "Sign in with Claude": its page's code pasted back,
// the plan named, an answer streamed, through the page's own server to recorded stand-ins. Plus what makes it an
// installable PWA.
// BYOKIT_EXAMPLE_SHOTS=<folder> takes the README pictures, showing the code in OpenAI's own format, not the stand-in's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import type { Page, Route } from 'playwright';
import { mockOpenAI } from '../../packages/accounts/src/testing/index.ts';
import { serve } from './serve.ts';

// Playwright's own Chromium (CI installs it); else the system's, for a machine without Playwright's download.
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const openai = await mockOpenAI();
const site = await serve(0, openai.base);
const browser = await chromium.launch({ executablePath });
after(async () => { await browser.close(); site.close(); await openai.close(); });
/** A part of one provider's card. */
const part = (page: Page, key: string, name: string) => page.locator(`#${key} [data-${name}]`);

test('sign in with ChatGPT in a browser: device code, the plan named, kept across a reload, signed out', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${site.url}?openai=https://attacker.example`);
  const status = part(page, 'chatgpt', 'status');
  await assert.doesNotReject(status.filter({ hasText: "ChatGPT isn't signed in yet." }).waitFor());
  assert.equal(await part(page, 'chatgpt', 'sheet').isVisible(), false, 'no sign-in sheet before the person starts');

  await part(page, 'chatgpt', 'signin').click();
  const code = (await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).textContent())!;
  assert.equal(await part(page, 'chatgpt', 'open').getAttribute('href'), `${openai.base}/codex/device`);
  assert.equal(await part(page, 'chatgpt', 'paste').isVisible(), false, 'nothing to paste for a device code');

  // The person opens the provider's page from the link and types the code there.
  const [provider] = await Promise.all([context.waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
  await provider.fill('#code', code);
  await provider.click('#continue');
  assert.match((await provider.locator('#words').textContent())!, /Signed in/);
  await provider.close();

  await status.filter({ hasText: 'ChatGPT is connected.' }).waitFor();
  await part(page, 'chatgpt', 'badge').filter({ hasText: 'ChatGPT Plus' }).waitFor();
  assert.equal(await part(page, 'chatgpt', 'who').textContent(), 'Signed in as sara@example.com');

  await page.reload();
  await status.filter({ hasText: 'ChatGPT is connected.' }).waitFor(); // kept in this browser's IndexedDB

  await part(page, 'chatgpt', 'signout').click();
  await status.filter({ hasText: "ChatGPT isn't signed in yet." }).waitFor();
  assert.equal(await part(page, 'chatgpt', 'sheet').isVisible(), false, 'old code is hidden after sign-out');
  assert.ok(openai.state.requests.some((r) => r.path === '/oauth/revoke'), 'ended at OpenAI too');
  await page.reload();
  await status.filter({ hasText: "ChatGPT isn't signed in yet." }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('sign in with Claude in a browser: its page, the code pasted back, the plan named, an answer streamed', async () => {
  const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../fixtures/conformance/${f}`, import.meta.url), 'utf8'));
  const plan = fixture('claude-plan-typescript.json'), messages = fixture('claude-messages-typescript.json').cases[0];
  // Routed here, so the page's own requests are seen (a service worker's would not be).
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const asked: { url: string; headers: Record<string, string>; body: any }[] = [];
  const answer = (body: string, type = 'application/json') => async (route: any) => {
    asked.push({ url: route.request().url(), headers: route.request().headers(), body: route.request().postDataJSON() });
    await route.fulfill({ body, contentType: type });
  };
  await page.route('**/fwd/claude/v1/oauth/token', answer(JSON.stringify({ ...plan.exchange, expires_in: 28_800 }))); // a real sign-in lasts hours
  await page.route('**/fwd/anthropic/api/oauth/profile', answer(JSON.stringify({ account: { email: 'umer@example.com' }, organization: { organization_type: 'claude_max' } })));
  await page.route('**/fwd/anthropic/v1/messages**', answer(messages.stream, 'text/event-stream'));
  await page.goto(site.url);
  const status = part(page, 'claude', 'status');
  await status.filter({ hasText: "Claude isn't signed in yet." }).waitFor();

  await part(page, 'claude', 'signin').click();
  await page.locator('#claude [data-open][href*="state="]').waitFor();
  const open = new URL((await part(page, 'claude', 'open').getAttribute('href'))!);
  assert.equal(open.origin + open.pathname, plan.authorize, "Claude's own page");
  assert.equal(await part(page, 'claude', 'code').isVisible(), false, 'no code to type for Claude');
  await part(page, 'claude', 'pasted').fill(`recorded-code#${open.searchParams.get('state')}`);
  await part(page, 'claude', 'connect').click();

  await status.filter({ hasText: 'Claude is connected.' }).waitFor();
  await part(page, 'claude', 'badge').filter({ hasText: 'Claude Max' }).waitFor();
  assert.equal(await part(page, 'claude', 'who').textContent(), 'Signed in as umer@example.com');
  assert.equal(asked[0].body.code, 'recorded-code');

  await part(page, 'claude', 'question').fill('Hello');
  await part(page, 'claude', 'ask').click();
  await part(page, 'claude', 'answer').filter({ hasText: messages.text }).waitFor();
  const inference = asked.find((a) => a.url.includes('/v1/messages'))!;
  assert.equal(inference.headers.authorization, 'Bearer recorded-access');
  assert.equal(inference.body.messages[0].content, 'Hello');

  await page.reload();
  await status.filter({ hasText: 'Claude is connected.' }).waitFor(); // kept in this browser's IndexedDB
  await part(page, 'claude', 'signout').click();
  await status.filter({ hasText: "Claude isn't signed in yet." }).waitFor();
  assert.equal((await fetch(`${site.url}fwd/elsewhere/x`)).status, 404, 'the page server passes on only to its named providers');
  await context.close();
});

test('Ask on both cards: one question at a time, Stop, and an older answer never overwrites a newer one', async () => {
  // Synthetic answers only: each question is held until the test answers it, with "<question> final", or fails it.
  const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../fixtures/conformance/${f}`, import.meta.url), 'utf8'));
  const plan = fixture('claude-plan-typescript.json'), recorded = fixture('claude-messages-typescript.json').cases[0].stream;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/fwd/claude/v1/oauth/token', (route) => route.fulfill({ json: { ...plan.exchange, expires_in: 28_800 } }));
  await page.route('**/fwd/anthropic/api/oauth/profile', (route) => route.fulfill({ json: { account: { email: 'umer@example.com' }, organization: { organization_type: 'claude_max' } } }));
  const held: { route: Route; question: string }[] = [];
  const stream = {
    chatgpt: (text: string) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`,
    // The recorded Claude stream, its text pieces swapped for one.
    claude: (text: string) => recorded.split('\n\n').filter((block: string) => !block.includes('text_delta') || block.includes('"Hello"'))
      .map((block: string) => block.replace('"Hello"', JSON.stringify(text))).join('\n\n'),
  };
  for (const [glob, question] of [['**/fwd/chatgpt/backend-api/codex/responses', (b: any) => b.input[0].content[0].text], ['**/fwd/anthropic/v1/messages**', (b: any) => b.messages[0].content]] as const)
    await page.route(glob, (route) => { held.push({ route, question: question(route.request().postDataJSON()) }); });
  // Same 30s deadline as every other wait in this file (Playwright's default waitFor timeout):
  // generous on a loaded build machine, far below the CI job cap, and consistent when reading a failure.
  const asked = async (n: number) => {
    const deadline = Date.now() + 30_000;
    while (held.length < n) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${n} inference request(s) to reach the test route; saw ${held.length} (${held.map((h) => h.question).join(', ') || 'none yet'})`);
      await page.waitForTimeout(20);
    }
  };
  const answer = (at: number, key: 'chatgpt' | 'claude') => held[at].route.fulfill({ body: stream[key](`${held[at].question} final`), contentType: 'text/event-stream' }).catch(() => {}); // a stopped one is gone

  await page.goto(site.url);
  await part(page, 'chatgpt', 'signin').click();
  const code = (await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).textContent())!;
  const [provider] = await Promise.all([context.waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
  await provider.fill('#code', code);
  await provider.click('#continue');
  await provider.close();
  await part(page, 'claude', 'signin').click();
  await page.locator('#claude [data-open][href*="state="]').waitFor();
  const state = new URL((await part(page, 'claude', 'open').getAttribute('href'))!).searchParams.get('state');
  await part(page, 'claude', 'pasted').fill(`recorded-code#${state}`);
  await part(page, 'claude', 'connect').click();

  for (const key of ['chatgpt', 'claude'] as const) {
    held.length = 0;
    await part(page, key, 'status').filter({ hasText: /is connected\./ }).waitFor();
    const ask = part(page, key, 'ask'), stop = part(page, key, 'stop'), out = part(page, key, 'answer');
    const idle = async () => { assert.equal(await ask.isDisabled(), false); assert.equal(await stop.isVisible(), false); };
    await idle();

    // A rapid double Ask is one question; Stop gives the controls back.
    await part(page, key, 'question').fill('First');
    await ask.evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await page.waitForTimeout(300);
    assert.equal(held.length, 1, `${key}: one question asked`);
    assert.equal(await ask.isDisabled(), true);
    await stop.click();
    await idle();

    // The stopped question's answer, arriving after a newer one, never replaces it.
    await part(page, key, 'question').fill('Second');
    await ask.click();
    await asked(2);
    await answer(1, key);
    await out.filter({ hasText: 'Second final' }).waitFor();
    await answer(0, key);
    await page.waitForTimeout(300);
    assert.equal(await out.textContent(), 'Second final', `${key}: the newest answer stays`);
    await idle();

    // A failed question says so and gives the controls back; the next one works.
    await part(page, key, 'question').fill('Third');
    await ask.click();
    await asked(3);
    await held[2].route.abort('failed');
    await page.waitForFunction((k) => !(document.querySelector(`#${k} [data-ask]`) as HTMLButtonElement).disabled, key);
    assert.match((await out.textContent())!, /fetch|could not answer/i, `${key}: the failure is shown`);
    await idle();
    await part(page, key, 'question').fill('Fourth');
    await ask.click();
    await asked(4);
    await answer(3, key);
    await out.filter({ hasText: 'Fourth final' }).waitFor();
    await idle();
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('two tabs serialize sign-out and a queued refresh through Web Locks', async () => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([first.goto(site.url), second.goto(site.url)]);
  const bundle = await build({ entryPoints: [new URL('../../packages/accounts/src/portable.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false });
  const source = bundle.outputFiles[0].text;
  for (const page of [first, second]) await page.evaluate(async (source) => {
    const module = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    (window as any).raceStore = module.browserStore('cross-tab-race');
  }, source);
  await first.evaluate(() => (window as any).raceStore.modify('openai-codex', async () => ({ type: 'oauth', access: 'first', refresh: 'first', expires: 0 })));
  await first.evaluate(() => {
    (window as any).signout = (window as any).raceStore.end('openai-codex', async () => {
      (window as any).revoking = true;
      await new Promise<void>((resolve) => { (window as any).release = resolve; });
    });
  });
  await first.waitForFunction(() => (window as any).revoking === true);
  await second.evaluate(() => {
    (window as any).refresh = (window as any).raceStore.modify('openai-codex', async (current: any) => {
      (window as any).rotated = current?.type === 'oauth';
      return current?.type === 'oauth' ? { ...current, refresh: 'rotated' } : undefined;
    });
  });
  await first.evaluate(() => (window as any).release());
  await Promise.all([first.evaluate(() => (window as any).signout), second.evaluate(() => (window as any).refresh)]);
  assert.equal(await second.evaluate(() => (window as any).rotated), false);
  assert.equal(await second.evaluate(() => (window as any).raceStore.read('openai-codex')), undefined);
  await context.close();
});

test('an installable PWA: its manifest and a service worker that keeps the page working offline', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(site.url);
  const manifest = await (await page.request.get(new URL((await page.locator('link[rel=manifest]').getAttribute('href'))!, site.url).href)).json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const response = await page.request.get(new URL(icon.src, site.url).href);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['content-type'], 'image/png');
    const dimensions = await page.evaluate(async (src) => {
      const image = new Image(); image.src = src; await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, icon.src);
    assert.equal(dimensions, icon.sizes);
  }
  for (const [selector, type] of [['link[rel=icon][type]', 'image/svg+xml'], ['link[rel=icon][sizes]', 'image/x-icon'], ['link[rel=apple-touch-icon]', 'image/png']]) {
    const href = await page.locator(selector!).getAttribute('href');
    const response = await page.request.get(new URL(href!, site.url).href);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['content-type'], type);
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now under the service worker
  await context.setOffline(true);
  await page.reload();
  assert.equal(await page.title(), 'byokit example');
  await context.close();
});

test('the README pictures: signed out, the code, connected', { skip: !process.env.BYOKIT_EXAMPLE_SHOTS }, async () => {
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 450 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(site.url);
    await part(page, 'chatgpt', 'status').filter({ hasText: "ChatGPT isn't signed in yet." }).waitFor();
    return { context, page, shot: (name: string) => page.screenshot({ path: join(process.env.BYOKIT_EXAMPLE_SHOTS!, `${name}.png`) }) };
  };
  const first = await open();
  await first.shot('pwa-1-signed-out');
  // Only the pictured code is swapped, and that sign-in stays waiting: it is never finished.
  await first.page.route(`${openai.base}/api/accounts/deviceauth/usercode`, async (route) =>
    route.fulfill({ json: { ...await (await route.fetch()).json(), user_code: 'WDJB-MJHT' } }));
  await first.page.route(`${openai.base}/api/accounts/deviceauth/token`, (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'deviceauth_authorization_pending' } }, headers: { 'access-control-allow-origin': '*' } }));
  await part(first.page, 'chatgpt', 'signin').click();
  await part(first.page, 'chatgpt', 'code').filter({ hasText: 'WDJB-MJHT' }).waitFor();
  await first.shot('pwa-2-code');
  await first.context.close();

  const { context, page, shot } = await open();
  const status = part(page, 'chatgpt', 'status');
  await part(page, 'chatgpt', 'signin').click();
  const code = (await part(page, 'chatgpt', 'code').filter({ hasText: /-/ }).textContent())!;
  const [provider] = await Promise.all([context.waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
  await provider.fill('#code', code);
  await provider.click('#continue');
  await provider.close();
  await status.filter({ hasText: 'ChatGPT is connected.' }).waitFor();
  await shot('pwa-3-connected');
  await context.close();
});
