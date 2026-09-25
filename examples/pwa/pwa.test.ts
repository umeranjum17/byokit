// "Sign in with ChatGPT" in a real browser (headless Chromium through Playwright), end to end against the stand-in
// OpenAI on another origin, as a person does it: the code on the page, typed on the provider's page in another tab,
// kept in IndexedDB across a reload, refreshed, signed out (revoked there). Plus what makes it an installable PWA.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { mockOpenAI } from '../../packages/accounts/src/testing/index.ts';
import { serve } from './serve.ts';

// Playwright's own Chromium (CI installs it); else the system's, for a machine without Playwright's download.
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const openai = await mockOpenAI();
const site = await serve();
const browser = await chromium.launch({ executablePath });
after(async () => { await browser.close(); site.close(); await openai.close(); });

test('sign in with ChatGPT in a browser: device code, kept across a reload, refreshed, signed out', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${site.url}?openai=${encodeURIComponent(openai.base)}`);
  const status = page.locator('#status');
  await assert.doesNotReject(status.filter({ hasText: "ChatGPT isn't signed in yet." }).waitFor());

  await page.click('#signin');
  const code = (await page.locator('#code').filter({ hasText: /^MOCK-/ }).textContent())!;
  assert.equal(await page.locator('#open').getAttribute('href'), `${openai.base}/codex/device`);

  // The person opens the provider's page from the link and types the code there.
  const [provider] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
  await provider.fill('#code', code);
  await provider.click('#continue');
  assert.match((await provider.locator('#words').textContent())!, /Signed in/);
  await provider.close();

  await status.filter({ hasText: 'ChatGPT is connected.' }).waitFor();
  assert.equal(await page.locator('#plan').textContent(), 'sara@example.com, plus plan');

  await page.reload();
  await status.filter({ hasText: 'ChatGPT is connected.' }).waitFor(); // kept in this browser's IndexedDB

  await page.click('#recheck');
  await page.locator('#note').filter({ hasText: 'the sign-in was refreshed' }).waitFor();
  assert.ok(openai.state.requests.some((r) => r.body.includes('grant_type=refresh_token')));

  await page.click('#signout');
  await status.filter({ hasText: "ChatGPT isn't signed in yet." }).waitFor();
  assert.ok(openai.state.requests.some((r) => r.path === '/oauth/revoke'), 'ended at OpenAI too');
  await page.reload();
  await status.filter({ hasText: "ChatGPT isn't signed in yet." }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('an installable PWA: its manifest and a service worker that keeps the page working offline', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(site.url);
  const manifest = await (await page.request.get(new URL((await page.locator('link[rel=manifest]').getAttribute('href'))!, site.url).href)).json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now under the service worker
  await context.setOffline(true);
  await page.reload();
  assert.equal(await page.title(), 'byokit example');
  await context.close();
});
