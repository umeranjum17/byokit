// "Sign in with ChatGPT" in a real browser (headless Chromium through Playwright), end to end against the stand-in
// OpenAI on another origin, as a person does it: the code on the page, typed on the provider's page in another tab,
// kept in IndexedDB across a reload, signed out (revoked there). "Sign in with Claude": its page's code pasted back,
// the plan named, an answer streamed, through the page's own server to recorded stand-ins. Plus what makes it an
// installable PWA.
// BYOKIT_EXAMPLE_SHOTS=<folder> takes the README pictures, showing the code in OpenAI's own format, not the stand-in's.
// Every test carries a 120s timeout: Playwright's launches, closes and evaluates have no timeout of their own, so a wedged
// one must fail this job with the test's name (node:test prints it) long before the CI job cap cancels the whole run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import type { Page, Route } from 'playwright';
import { mockDevice, mockOpenAI } from '@byokit/accounts/testing';
import { serve } from './serve.ts';

// Playwright's own Chromium (CI installs it); else the system's, for a machine without Playwright's download.
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const openai = await mockOpenAI();
const device = await mockDevice();
const site = await serve(0, openai.base, device.base);
const browser = await chromium.launch({ executablePath });
after(async () => { await browser.close(); site.close(); await openai.close(); await device.close(); });
/** A part of one provider's card. */
const part = (page: Page, key: string, name: string) => page.locator(`#${key} [data-${name}]`);

test('sign in with ChatGPT in a browser: device code, the plan named, kept across a reload, signed out', { timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${site.url}?openai=https://attacker.example`);
  await part(page, 'chatgpt', 'signin').waitFor();
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

  await page.locator('#chatgpt [data-email]').filter({ hasText: 'umer@example.com' }).waitFor();
  await part(page, 'chatgpt', 'badge').filter({ hasText: 'ChatGPT Plus' }).waitFor();
  assert.match((await page.locator('#chatgpt [data-email]').filter({ hasText: 'umer@example.com' }).textContent())!, /umer@example\.com/);
  assert.equal(await page.locator('#chatgpt [data-chip]').count(), 0, 'no plan pill repeats on any account row');

  await page.reload();
  await page.locator('#chatgpt [data-email]').filter({ hasText: 'umer@example.com' }).waitFor(); // kept in this browser's IndexedDB

  await part(page, 'chatgpt', 'signout').click();
  await part(page, 'chatgpt', 'signin').waitFor();
  assert.equal(await part(page, 'chatgpt', 'sheet').isVisible(), false, 'old code is hidden after sign-out');
  assert.ok(openai.state.requests.some((r) => r.path === '/oauth/revoke'), 'ended at OpenAI too');
  await page.reload();
  await part(page, 'chatgpt', 'signin').waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('Grok in the built browser app: a dropped poll, approval, reload, sign-out; host-only SDK rejection', { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${site.url}?device=https://attacker.example`);
    await part(page, 'grok', 'signin').waitFor();
    assert.equal(await part(page, 'grok', 'billing').textContent(), 'Plan');
    assert.equal(await page.locator('#anthropic').count(), 0, 'a billed API key is not offered as a plan');
    device.state.dropPolls = 1;
    await part(page, 'grok', 'signin').click();
    const codeAt = part(page, 'grok', 'code').filter({ hasText: /^FIXTURE-/ });
    await codeAt.waitFor();
    assert.equal(await part(page, 'grok', 'open').getAttribute('href'), `${device.base}/activate`);
    assert.equal(await part(page, 'grok', 'paste').isVisible(), false);
    // mockDevice is a local HTTP service, not a live vendor or a provider-page fixture.
    assert.equal(device.approve((await codeAt.textContent())!), true);
    await part(page, 'grok', 'status').filter({ hasText: /is connected/ }).waitFor();
    assert.equal(device.state.dropPolls, 0, 'the dropped poll was consumed before connecting');
    assert.ok(device.state.requests.filter((r) => r.path === '/oauth2/token').length >= 2);
    assert.equal(await part(page, 'grok', 'billing').textContent(), 'Plan', 'no invented paid tier');
    await page.reload();
    await part(page, 'grok', 'status').filter({ hasText: /is connected/ }).waitFor();
    await part(page, 'grok', 'signout').click();
    await part(page, 'grok', 'signin').waitFor();
    assert.equal(await part(page, 'grok', 'sheet').isVisible(), false);
    await page.reload();
    await part(page, 'grok', 'signin').waitFor();

    // Separate SDK/browser-API negative, not a host-card journey: built browser exports only.
    const bundle = await build({ stdin: { contents: "export * from '@byokit/accounts';", resolveDir: process.cwd() },
      bundle: true, platform: 'browser', format: 'esm', write: false });
    const before = device.state.requests.length;
    const hostRequests: string[] = [];
    page.on('request', (r) => { if (/^https?:/.test(r.url())) hostRequests.push(r.url()); });
    const negative = await page.evaluate(async (source) => {
      const sdk = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      const route = sdk.route('custom:endpoint', { platform: 'browser' });
      const kit = new sdk.Accounts({ store: () => sdk.memoryStore() });
      try {
        await kit.endpoint(1, { baseUrl: 'http://127.0.0.1:1/v1', compat: 'openai', billing: 'api' });
        throw new Error('host-only endpoint was accepted');
      } catch (e: any) {
        return { readiness: route.readiness, words: route.why, error: e.readiness, message: e.message, code: kit.view(1, 'custom:endpoint')?.code };
      }
    }, bundle.outputFiles[0].text);
    assert.equal(negative.readiness, 'needs_host');
    assert.equal(negative.words, "This sign-in method needs the app's host side.");
    assert.equal(negative.error, 'needs_host');
    assert.equal(negative.message, 'This endpoint needs the app’s host side.');
    assert.equal(negative.code, undefined);
    assert.equal(device.state.requests.length, before, 'host-only rejection never asks the device provider');
    assert.deepEqual(hostRequests, [], 'host-only rejection makes no HTTP request');
    assert.deepEqual(errors, []);
    console.log('SDK/browser-API negative:', negative);
  } finally { await context.close(); }
});

test('Add an account: every route grouped, Plans first, unavailable ones say why and cannot be tapped, a plan starts its card', { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(site.url);
    await part(page, 'chatgpt', 'signin').waitFor();
    assert.equal(await page.locator('#add-sheet').isVisible(), false, 'closed until the person opens it');
    await page.locator('#add-open').click();
    const groups = await page.locator('#add-groups [data-group]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group));
    assert.deepEqual(groups.slice(0, 2), ['plans', 'perUse'], 'Plans first, then Pay per use');
    const { routes } = await import('@byokit/accounts');
    assert.equal(await page.locator('#add-groups [data-route]').count(), routes({ platform: 'browser' }).length, 'every route is listed');
    const lines = (g: string) => page.locator(`[data-group="${g}"] .route-line`).allTextContents();
    assert.ok((await lines('plans')).every((l) => l.startsWith('Uses your ')), 'a plan says it uses your plan');
    assert.ok((await lines('perUse')).every((l) => l.startsWith('Charged per use')), 'nothing billed per use is a plan');
    const row = (id: string) => page.locator(`[data-route="${id}"]`);
    assert.equal(await row('openai:code').locator('.route-name').textContent(), 'ChatGPT — sign in with a code', 'each card names its way in');
    for (const g of groups) {
      const unavailable = await page.locator(`[data-group="${g}"] .route`).evaluateAll((els) => els.map((e) => e.hasAttribute('data-unavailable')));
      assert.deepEqual(unavailable, [...unavailable].sort((a, b) => Number(a) - Number(b)), `${g}: ready ways in before unavailable ones`);
    }
    for (const [id, words] of [['anthropic:paste', 'Needs the app on your computer.'], ['openai:browser', 'Not available on this device.']]) {
      assert.equal(await row(id).isDisabled(), true, `${id} cannot be tapped`);
      assert.equal(await row(id).getAttribute('data-unavailable'), '');
      assert.equal(await row(id).locator('.route-status').textContent(), words);
    }
    await row('anthropic:paste').click({ force: true });
    assert.equal(await page.locator('#add-sheet').isVisible(), true, 'an unavailable row does nothing');
    assert.equal(await part(page, 'claude', 'sheet').isVisible(), false);
    assert.equal(await row('openai:key').isDisabled(), true, 'a key this page has no form for is not offered');
    assert.equal(await row('openai:key').getAttribute('data-unavailable'), null);
    const soon = page.locator('[data-group="coming-soon"]');
    await soon.waitFor();
    assert.equal(groups.at(-1), 'coming-soon', 'the Coming soon group comes last');
    assert.deepEqual((await page.locator('#add-groups [data-group]:not([data-group="coming-soon"]) .route-status').allTextContents())
      .filter((s) => s === 'Ready, but this page has no form for it yet.'), [],
      'no "no form for it yet" row outside the Coming soon group');
    assert.equal(await soon.locator('[data-route]').first().isVisible(), false, 'the Coming soon group starts closed');
    assert.equal(await soon.locator('[data-coming-toggle]').getAttribute('aria-expanded'), 'false');
    await row('openai:code').click();
    await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).waitFor();
    assert.equal(await page.locator('#add-sheet').isVisible(), false, 'the sheet closes on the card it started');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'chatgpt', 'focus lands on that card');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Add an OpenCode Go plan account: its row opens the paste-key form, a pasted key connects and is kept', { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // The kit lists the key's workspaces on OpenCode's console before it saves a Go key: one workspace here, never the
    // real network; the page's own server carries the call. The first answer cannot be read (a server error): the form
    // shows the kit's typed words and keeps nothing. The usage read stays unanswered either way, so the row keeps its
    // unknown room.
    let consoleDown = true;
    await page.route('**/fwd/opencode/console/api/orgs', (route) => {
      return consoleDown ? route.fulfill({ status: 503, body: '' })
        : route.fulfill({ status: 200, contentType: 'application/json', json: [{ id: 'org_WORKING2', name: 'Working2' }] });
    });
    await page.route('**/fwd/opencode/zen/go/v1/usage', (route) => route.fulfill({ status: 401, body: '' }));
    await page.goto(site.url);
    await part(page, 'opencode', 'signin').waitFor();
    assert.equal(await part(page, 'opencode', 'billing').textContent(), 'Plan');
    await page.locator('#add-open').click();
    const row = page.locator('[data-route="opencode:plan_key:opencode-go"]');
    await row.waitFor();
    assert.equal(await row.getAttribute('aria-disabled'), null, 'the Go row can be tapped');
    assert.equal(await row.locator('.route-status').textContent(), 'Ready');
    assert.equal(await row.locator('.route-name').textContent(), 'OpenCode Go — paste the key from your plan', 'each card names its way in');
    assert.equal(await page.locator('[data-group="coming-soon"] [data-route="opencode:plan_key:opencode-go"]').count(), 0, 'the Go row stays in Plans, not Coming soon');
    await row.click();
    assert.equal(await page.locator('#add-sheet').isVisible(), false, 'the sheet closes on the card it started');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'opencode', 'focus lands on that card');
    // The form opens on the card's async redraw, so wait for it instead of asserting one synchronous frame.
    await part(page, 'opencode', 'paste').waitFor({ state: 'visible' });
    assert.equal(await part(page, 'opencode', 'pasted').getAttribute('placeholder'), 'Paste the key from your plan');
    assert.equal(await part(page, 'opencode', 'pasted').getAttribute('type'), 'password', 'a plan key is collected with hidden typing');
    await part(page, 'opencode', 'pasted').fill('fake-go-plan-key-canary');
    await part(page, 'opencode', 'connect').click();
    await page.locator('#opencode').getByText('Couldn’t reach OpenCode to check this key’s workspaces. Check the internet connection, then try again.').waitFor();
    assert.equal(await part(page, 'opencode', 'signout').isVisible(), false, 'nothing kept');
    consoleDown = false;
    await part(page, 'opencode', 'connect').click();
    await part(page, 'opencode', 'status').filter({ hasText: /is connected/ }).waitFor();
    await page.locator('#opencode [data-room]').filter({ hasText: 'Room left unknown' }).waitFor();
    assert.match((await page.locator('#opencode [data-email]').textContent())!, /OpenCode Go/);
    assert.equal(await page.locator('#opencode [data-chip]').count(), 0, 'no plan pill repeats on any account row');

    await page.reload();
    await part(page, 'opencode', 'status').filter({ hasText: /is connected/ }).waitFor(); // kept in this browser's stores
    await page.locator('#opencode [data-room]').filter({ hasText: 'Room left unknown' }).waitFor();

    await part(page, 'opencode', 'signout').click();
    await part(page, 'opencode', 'signin').waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Add an OpenCode Go account whose key acts for several workspaces: the pick shows, the chosen workspace connects, its usage shows', { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // The kit answers a multi-workspace key with typed workspaces, nothing saved yet; the page's own server
    // carries the console and Go calls, so both stand-ins ride the same origin here.
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    await page.route('**/fwd/opencode/console/api/orgs', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 'wrk_01', name: 'Default' }, { id: 'wrk_02', name: 'Working' }]) }));
    await page.route('**/fwd/opencode/zen/go/v1/usage', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ usage: { rolling: { status: 'ok', percent: 20, resetsAt: soon },
        weekly: { status: 'ok', percent: 10, resetsAt: soon }, monthly: { status: 'rate-limited', percent: 100, resetsAt: soon } } }) }));
    await page.goto(site.url);
    await part(page, 'opencode', 'signin').waitFor();
    await page.locator('#add-open').click();
    await page.locator('[data-route="opencode:plan_key:opencode-go"]').click();
    await part(page, 'opencode', 'paste').waitFor({ state: 'visible' });
    await part(page, 'opencode', 'pasted').fill('fake-go-plan-key-canary');
    await part(page, 'opencode', 'connect').click();
    // The key alone connects nothing: the pick shows first, and cancel keeps everything.
    const pick = part(page, 'opencode', 'workspaces');
    await pick.waitFor({ state: 'visible' });
    assert.match((await part(page, 'opencode', 'words').textContent())!, /workspace/i);
    await part(page, 'opencode', 'cancel').click();
    await part(page, 'opencode', 'signin').waitFor();
    assert.equal(await pick.isVisible(), false, 'cancel drops the pick and the kept key');

    // Again, and this time pick the workspace: the account connects and its usage windows show.
    await page.locator('#add-open').click();
    await page.locator('[data-route="opencode:plan_key:opencode-go"]').click();
    await part(page, 'opencode', 'paste').waitFor({ state: 'visible' });
    await part(page, 'opencode', 'pasted').fill('fake-go-plan-key-canary');
    await part(page, 'opencode', 'connect').click();
    await pick.waitFor({ state: 'visible' });
    await pick.selectOption({ label: 'Working' });
    await part(page, 'opencode', 'connect').click();
    await part(page, 'opencode', 'status').filter({ hasText: /is connected/ }).waitFor();
    await page.locator('#opencode [data-room]').filter({ hasText: '0% left this month' }).waitFor();
    await page.locator('#opencode [data-window]').filter({ hasText: 'Session: 80% left' }).waitFor();
    await page.locator('#opencode [data-window]').filter({ hasText: 'Month: 0% left' }).waitFor();

    await page.reload();
    await part(page, 'opencode', 'status').filter({ hasText: /is connected/ }).waitFor(); // kept in this browser's stores
    await page.locator('#opencode [data-room]').filter({ hasText: '0% left this month' }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Add sheet rows start their own card: a signed-in plan row adds another sign-in with its code; a tap while one waits starts nothing new', { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const usercodes = () => openai.state.requests.filter((r) => r.path === '/api/accounts/deviceauth/usercode').length;
    const shownCode = () => page.locator('#chatgpt [data-sheet]:not([hidden]) [data-code]').textContent();
    await page.goto(site.url);
    await part(page, 'chatgpt', 'signin').click();
    const code = (await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).textContent())!;
    const [provider] = await Promise.all([context.waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
    await provider.fill('#code', code);
    await provider.click('#continue');
    assert.match((await provider.locator('#words').textContent())!, /Signed in/); // let the form's page land first: closing mid-navigation wedges page.close(), which has no timeout of its own
    await provider.close();
    await page.locator('#chatgpt [data-email]').filter({ hasText: 'umer@example.com' }).waitFor();

    await page.locator('#add-open').click();
    await page.locator('[data-route="openai:code"]').click();
    await page.waitForFunction((first) => {
      const shown = document.querySelector('#chatgpt [data-sheet]:not([hidden]) [data-code]')?.textContent ?? '';
      return shown.startsWith('MOCK-') && shown !== first;
    }, code);
    const added = await shownCode();
    assert.equal(await part(page, 'chatgpt', 'signin').isVisible(), false, 'the card is not signed out');
    assert.equal(await page.locator('#add-sheet').isVisible(), false, 'the sheet closes on the card it started');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'chatgpt', 'focus lands on that card');

    const started = usercodes();
    await page.locator('#add-open').click();
    await page.locator('[data-route="openai:code"]').click();
    await page.waitForTimeout(1500);
    assert.equal(usercodes(), started, 'a tap while that sign-in waits starts nothing new');
    assert.equal(await shownCode(), added, 'the waiting code is the one shown');
    assert.equal(await part(page, 'chatgpt', 'sheet').isVisible(), true, 'the pending sign-in stays on its card');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('an added sign-in that runs out: the card is not stuck, its expiry words survive an unrelated redraw', { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.clock.install();
    await page.goto(site.url);
    await part(page, 'chatgpt', 'signin').click();
    const code = (await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).textContent())!;
    const [provider] = await Promise.all([context.waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
    await provider.fill('#code', code);
    await provider.click('#continue');
    assert.match((await provider.locator('#words').textContent())!, /Signed in/); // let the form's page land first: closing mid-navigation wedges page.close(), which has no timeout of its own
    await provider.close();
    await page.locator('#chatgpt [data-email]').filter({ hasText: 'umer@example.com' }).waitFor();

    await page.locator('#add-open').click();
    await page.locator('[data-route="openai:code"]').click();
    await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).waitFor();
    await page.clock.fastForward(16 * 60_000);
    await part(page, 'chatgpt', 'add').waitFor({ state: 'visible' });
    assert.equal(await part(page, 'chatgpt', 'sheet').isVisible(), false, 'the expired sheet is gone');
    assert.equal(await part(page, 'chatgpt', 'note').getAttribute('data-tone'), 'expired', 'the card says the code ran out');
    const words = await part(page, 'chatgpt', 'note').textContent();

    await part(page, 'chatgpt', 'pick').dispatchEvent('change');
    await page.waitForTimeout(300);
    assert.equal(await part(page, 'chatgpt', 'note').isVisible(), true, 'the words survive an unrelated redraw');
    assert.equal(await part(page, 'chatgpt', 'note').textContent(), words);
    assert.equal(await part(page, 'chatgpt', 'add').isVisible(), true, 'Add another is back, so the card is not stuck');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('sign in with Claude in a browser: its page, the code pasted back, the plan named, an answer streamed', { timeout: 120_000 }, async () => {
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
  // Claude's own model list, as the vendor answers it: the model asked with is picked from it.
  await page.route('**/fwd/anthropic/v1/models', answer(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] })));
  await page.goto(site.url);
  await part(page, 'claude', 'signin').waitFor();

  await part(page, 'claude', 'signin').click();
  await page.locator('#claude [data-open][href*="state="]').waitFor();
  const open = new URL((await part(page, 'claude', 'open').getAttribute('href'))!);
  assert.equal(open.origin + open.pathname, plan.authorize, "Claude's own page");
  assert.equal(await part(page, 'claude', 'code').isVisible(), false, 'no code to type for Claude');
  await part(page, 'claude', 'pasted').fill(`recorded-code#${open.searchParams.get('state')}`);
  await part(page, 'claude', 'connect').click();

  await page.locator('#claude [data-email]').filter({ hasText: 'umer@example.com' }).waitFor();
  await part(page, 'claude', 'badge').filter({ hasText: 'Claude Max' }).waitFor();
  assert.match((await page.locator('#claude [data-email]').textContent())!, /umer@example\.com/);
  assert.equal(await page.locator('#claude [data-chip]').count(), 0, 'no plan pill repeats on any account row');
  assert.equal(asked[0].body.code, 'recorded-code');

  await part(page, 'claude', 'question').fill('Hello');
  await part(page, 'claude', 'ask').click();
  await part(page, 'claude', 'answer').filter({ hasText: messages.text }).waitFor();
  const inference = asked.find((a) => a.url.includes('/v1/messages'))!;
  assert.equal(inference.headers.authorization, 'Bearer recorded-access');
  assert.equal(inference.body.model, 'claude-sonnet-4-5', "a model from Claude's own list");
  assert.equal(inference.body.messages[0].content, 'Hello');

  await page.reload();
  await page.locator('#claude [data-email]').filter({ hasText: 'umer@example.com' }).waitFor(); // kept in this browser's IndexedDB
  await part(page, 'claude', 'signout').click();
  await part(page, 'claude', 'signin').waitFor();
  assert.equal((await fetch(`${site.url}fwd/elsewhere/x`)).status, 404, 'the page server passes on only to its named providers');
  await context.close();
});

test('two ChatGPT plans: every plan listed with billing, room and both windows, Auto asks the roomiest, switching sticks, Move when low, a signed-out pick runs nothing, a day-old reading stale', { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  // The page's clock runs as usual until the reading is made a day old at the end.
  await page.clock.install();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Each test plan's live quota, as its provider reports it: acct-1 nearly spent and low, acct-2 nearly full; the
  // week is half as used as the session.
  const quota = (used: number) => ({ rate_limit: {
    primary_window: { used_percent: used, limit_window_seconds: 18000, reset_after_seconds: 3600 },
    secondary_window: { used_percent: Math.floor(used / 2), limit_window_seconds: 604800, reset_after_seconds: 302400 } } });
  let usageDown = false;
  await page.route('**/fwd/chatgpt/backend-api/wham/usage', (route) => usageDown ? route.fulfill({ status: 503, body: '' }) : route.fulfill({
    json: route.request().headers()['chatgpt-account-id'] === 'acct-2' ? quota(10) : quota(85) }));
  // Each plan's own model list, as ChatGPT answers it.
  await page.route('**/fwd/chatgpt/backend-api/codex/models', (route) => route.fulfill({ json: { models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' }] } }));
  const askedIds: string[] = [];
  // The next answer fails once as a plan exclusion, then answers normally.
  let failPlan = false;
  const answer = (text: string) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`;
  await page.route('**/fwd/chatgpt/backend-api/codex/responses', (route) => {
    if (failPlan) {
      failPlan = false;
      return route.fulfill({ status: 403,
        json: { error: { code: 'usage_not_included', message: "Your plan doesn't include Codex for this request." } } });
    }
    const body = route.request().postDataJSON() as any;
    const text = body?.input?.[0]?.content?.[0]?.text ?? 'hello';
    askedIds.push(route.request().headers()['chatgpt-account-id']);
    return route.fulfill({ body: answer(`${text} final`), contentType: 'text/event-stream' });
  });
  const approve = async () => {
    await part(page, 'chatgpt', 'sheet').waitFor({ state: 'visible' });
    const code = (await part(page, 'chatgpt', 'code').filter({ hasText: /^MOCK-/ }).textContent())!;
    const [provider] = await Promise.all([context.waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
    await provider.fill('#code', code);
    await provider.click('#continue');
    assert.match((await provider.locator('#words').textContent())!, /Signed in/);
    await provider.close();
  };
  await page.goto(site.url);
  await part(page, 'chatgpt', 'signin').click();
  await approve();
  await page.locator('#chatgpt [data-email]').filter({ hasText: 'umer@example.com' }).waitFor();

  openai.state.accountId = 'acct-2';
  openai.state.email = 'b@example.com';
  await part(page, 'chatgpt', 'add').click();
  await approve();
  const rows = page.locator('#chatgpt [data-account]');
  await assert.doesNotReject(rows.filter({ hasText: 'b@example.com' }).waitFor());
  assert.equal(await rows.count(), 2, 'every connected plan lists before the Add rows');
  assert.equal(await page.locator('#chatgpt [data-chip]').count(), 0, 'no plan pill repeats on any account row');
  await page.locator('#chatgpt [data-room]').filter({ hasText: 'Plus · 90% left this session' }).waitFor();
  await page.locator('#chatgpt [data-room]').filter({ hasText: 'Plus · 15% left this session' }).waitFor();
  // Both windows under each plan, tightest first, each with its reset, then how old the reading is.
  const lines = async (id: string) => page.locator(`#chatgpt [data-account="${id}"]`).locator('[data-window], [data-age]').allTextContents();
  const low = (await page.locator('#chatgpt [data-account]').filter({ hasText: 'umer@example.com' }).getAttribute('data-account'))!;
  const roomy = (await page.locator('#chatgpt [data-account]').filter({ hasText: 'b@example.com' }).getAttribute('data-account'))!;
  const resets = /^(Session: \d+% left · resets in (59m|1h)|Week: \d+% left · resets in 3d (11h|12h)|Read a moment ago)$/;
  for (const id of [low, roomy]) for (const l of await lines(id)) assert.match(l, resets);
  assert.deepEqual((await lines(low)).map((l) => l.replace(/ · .*/, '')), ['Session: 15% left', 'Week: 58% left', 'Read a moment ago']);
  assert.deepEqual((await lines(roomy)).map((l) => l.replace(/ · .*/, '')), ['Session: 90% left', 'Week: 95% left', 'Read a moment ago']);

  const ask = async (question: string) => {
    await part(page, 'chatgpt', 'question').fill(question);
    await part(page, 'chatgpt', 'ask').click();
    await part(page, 'chatgpt', 'answer').filter({ hasText: `${question} final` }).waitFor();
  };
  await ask('first');
  assert.equal(askedIds.at(-1), 'acct-2', 'Auto lands on the account with the most room');
  assert.match((await part(page, 'chatgpt', 'picked').textContent())!, /Right now that's ChatGPT: 90% left this session/);

  await page.locator('#chatgpt [data-pick]').selectOption('chatgpt');
  await ask('second');
  assert.equal(askedIds.at(-1), 'acct-1', 'manual switching asks the chosen account');
  assert.equal(askedIds.filter((id) => id === 'acct-1').length, 1, 'the run never switches account mid-stream');
  assert.match((await part(page, 'chatgpt', 'picked').textContent())!, /You chose umer@example\.com\./);

  // The chosen account is low, so the card suggests the roomier one; taking it asks there.
  await part(page, 'chatgpt', 'move').filter({ hasText: 'Move to' }).waitFor();
  assert.match((await part(page, 'chatgpt', 'move').textContent())!, /Move to .*b@example\.com/);
  await part(page, 'chatgpt', 'move').click();
  await ask('third');
  assert.equal(askedIds.at(-1), 'acct-2', 'the Move target answers after the switch');

  // The plan stops including the run: the account stays listed but cannot run, and picking it runs nothing.
  await page.locator('#chatgpt [data-pick]').selectOption('chatgpt');
  failPlan = true;
  await part(page, 'chatgpt', 'question').fill('excluded');
  await part(page, 'chatgpt', 'ask').click();
  await part(page, 'chatgpt', 'answer').filter({ hasText: /usage limit/ }).waitFor();
  await page.locator('#chatgpt [data-room]').filter({ hasText: 'Not in your plan' }).first().waitFor();
  const runs = askedIds.length;
  await part(page, 'chatgpt', 'question').fill('signed-out pick');
  await part(page, 'chatgpt', 'ask').click();
  await part(page, 'chatgpt', 'answer').filter({ hasText: 'Sign in first' }).waitFor();
  assert.equal(askedIds.length, runs, 'a signed-out pick runs nothing');
  assert.equal(await part(page, 'chatgpt', 'ask').isDisabled(), false, 'the controls come back');
  assert.equal(await part(page, 'chatgpt', 'stop').isVisible(), false);

  // A day later the quota cannot be read: the last reading says how old it is and that it is stale; its session reset
  // since then, so that window and the room line say so instead of an old percent, while the week keeps its numbers.
  usageDown = true;
  await page.clock.setSystemTime(Date.now() + 25 * 3_600_000);
  await page.locator('#chatgpt [data-pick]').dispatchEvent('change');
  const stale = page.locator(`#chatgpt [data-account="${roomy}"][data-stale]`);
  await stale.locator('[data-age]').filter({ hasText: 'Read 1 day ago (stale)' }).waitFor();
  assert.deepEqual(await lines(roomy), ['Session: reset since this reading', 'Week: 95% left · resets in 2d 11h', 'Read 1 day ago (stale)']);
  await page.locator(`#chatgpt [data-account="${roomy}"] [data-room]`).filter({ hasText: 'Plus · Reset since this reading' }).waitFor();
  assert.equal(await page.locator(`#chatgpt [data-account="${roomy}"] .meter`).count(), 0, 'no bar for a reset room');
  assert.deepEqual(errors, []);
  openai.state.accountId = 'acct-1';
  openai.state.email = 'umer@example.com';
  await context.close();
});

test('Ask on both cards: one question at a time, Stop, and an older answer never overwrites a newer one', { timeout: 120_000 }, async () => {
  // Synthetic answers only: each question is held until the test answers it, with "<question> final", or fails it.
  const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../fixtures/conformance/${f}`, import.meta.url), 'utf8'));
  const plan = fixture('claude-plan-typescript.json'), recorded = fixture('claude-messages-typescript.json').cases[0].stream;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/fwd/claude/v1/oauth/token', (route) => route.fulfill({ json: { ...plan.exchange, expires_in: 28_800 } }));
  await page.route('**/fwd/anthropic/api/oauth/profile', (route) => route.fulfill({ json: { account: { email: 'umer@example.com' }, organization: { organization_type: 'claude_max' } } }));
  // Each vendor's own model list.
  await page.route('**/fwd/anthropic/v1/models', (route) => route.fulfill({ json: { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] } }));
  await page.route('**/fwd/chatgpt/backend-api/codex/models', (route) => route.fulfill({ json: { models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' }] } }));
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
  assert.match((await provider.locator('#words').textContent())!, /Signed in/); // let the form's page land first: closing mid-navigation wedges page.close(), which has no timeout of its own
  await provider.close();
  await part(page, 'claude', 'signin').click();
  await page.locator('#claude [data-open][href*="state="]').waitFor();
  const state = new URL((await part(page, 'claude', 'open').getAttribute('href'))!).searchParams.get('state');
  await part(page, 'claude', 'pasted').fill(`recorded-code#${state}`);
  await part(page, 'claude', 'connect').click();

  for (const key of ['chatgpt', 'claude'] as const) {
    held.length = 0;
    await page.locator(`#${key} [data-account]`).waitFor();
    const ask = part(page, key, 'ask'), stop = part(page, key, 'stop'), out = part(page, key, 'answer');
    const idle = async () => { assert.equal(await ask.isDisabled(), false); assert.equal(await stop.isVisible(), false); };
    await idle();

    // A rapid double Ask is one question; Stop gives the controls back.
    await part(page, key, 'question').fill('First');
    await ask.evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await asked(1);
    await page.waitForTimeout(300); // negative window: a second request from the double click would land here
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
    await page.waitForTimeout(300); // negative window: the stopped answer must not replace the newer one
    assert.equal(await out.textContent(), 'Second final', `${key}: the newest answer stays`);
    await idle();

    // A failed question says so and gives the controls back; the next one works.
    await part(page, key, 'question').fill('Third');
    await ask.click();
    await asked(3);
    await held[2].route.abort('failed');
    await page.waitForFunction((k) => !(document.querySelector(`#${k} [data-ask]`) as HTMLButtonElement).disabled, key);
    // The Claude card names an unreachable network in plain words; the ChatGPT card keeps the browser's own fetch error.
    assert.match((await out.textContent())!, key === 'claude' ? /could not be reached/ : /fetch/i, `${key}: the failure is shown`);
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

test('two tabs serialize sign-out and a queued refresh through Web Locks', { timeout: 120_000 }, async () => {
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

test('an installable PWA: its manifest and a service worker that keeps the page working offline', { timeout: 120_000 }, async () => {
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

test('the README pictures: signed out, the code, connected', { skip: !process.env.BYOKIT_EXAMPLE_SHOTS, timeout: 120_000 }, async () => {
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 450 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(site.url);
    await part(page, 'chatgpt', 'signin').waitFor();
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
  await part(page, 'chatgpt', 'signin').click();
  const code = (await part(page, 'chatgpt', 'code').filter({ hasText: /-/ }).textContent())!;
  const [provider] = await Promise.all([context.waitForEvent('page'), part(page, 'chatgpt', 'open').click()]);
  await provider.fill('#code', code);
  await provider.click('#continue');
  assert.match((await provider.locator('#words').textContent())!, /Signed in/); // as above: never close the page while its form's navigation is still in flight
  await provider.close();
  await page.locator('#chatgpt [data-email]').filter({ hasText: 'umer@example.com' }).waitFor();
  await shot('pwa-3-connected');
  await context.close();
});
