// Real service-worker install, offline fetch/navigation and v3 -> current upgrade; no provider calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { serve } from './serve.ts';

const legacy = `const SHELL = ['./', 'index.html', 'app.js', 'pair.html', 'pair.js'];
self.addEventListener('install', e => e.waitUntil(caches.open('byokit-shell-v3').then(c => c.addAll(SHELL))));
self.addEventListener('fetch', e => { if (new URL(e.request.url).origin !== location.origin) return;
e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); });`;

test('installed shell includes usage offline and upgrades only its own old caches', async () => {
  const site = await serve();
  let worker = legacy;
  const server = createServer(async (req, res) => {
    if (req.url === '/sw.js') return res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(worker);
    const response = await fetch(new URL(req.url!, site.url));
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type')! }).end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const browser = await chromium.launch({ executablePath: existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium' });
  try {
    const context = await browser.newContext();
    let page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await context.setOffline(true);
    const legacyReceipt = await page.evaluate(async () => ({
      pair: (await fetch('pair.html')).status,
      usageMissing: await fetch('usage.html').then(() => false, () => true),
    }));
    console.log('legacy offline receipt', legacyReceipt);
    assert.deepEqual(legacyReceipt, { pair: 200, usageMissing: true }, 'original missing usage response, with pairing as control');
    await context.setOffline(false);
    await page.evaluate(async () => {
      await caches.open('unrelated-app');
      await (await caches.open('byokit-shell-v3')).put('usage.js', new Response('stale usage'));
    });
    worker = readFileSync(new URL('sw.js', import.meta.url), 'utf8');
    await page.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration())!;
      await registration.update();
      await new Promise<void>(resolve => {
        if (registration.waiting) return resolve();
        const installing = registration.installing!;
        installing.addEventListener('statechange', () => { if (installing.state === 'installed') resolve(); });
      });
    });
    await page.close(); // normal update lifecycle: the old client's session ends
    page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    const keys = await page.evaluate(() => caches.keys());
    console.log('active cache receipt', keys);
    assert.ok(!keys.includes('byokit-shell-v3'));
    assert.ok(keys.includes('unrelated-app'));
    const onlineMiss = await page.evaluate(async () => (await fetch('missing.js')).status);
    assert.equal(onlineMiss, 404, 'online HTTP errors are not masked by an offline response');
    await context.setOffline(true);
    for (const path of ['', 'index.html', 'app.js', 'pair.html', 'pair.js', 'usage.html', 'usage.js']) {
      const receipt = await page.evaluate(async path => {
        const response = await fetch(path || './');
        return { status: response.status, text: await response.text() };
      }, path);
      console.log('offline shell receipt', path || '/', receipt.status, receipt.text.length);
      assert.equal(receipt.status, 200, path);
      assert.notEqual(receipt.text, 'stale usage');
      assert.ok(receipt.text.length > 0, path);
    }
    for (const [path, title] of [['', 'byokit example'], ['pair.html', 'Pair this browser'], ['usage.html', 'Your plans · BYOKit']]) {
      await page.goto(url + path);
      assert.equal(await page.title(), title);
      if (path === 'usage.html') await page.getByText('Umer', { exact: true }).waitFor();
      if (path === 'pair.html') await page.getByRole('button', { name: 'Pair this browser' }).waitFor();
    }
    const fallback = await page.goto(url + 'never-cached');
    assert.equal(fallback!.status(), 503);
    assert.match(await page.locator('body').innerText(), /offline/i);
    await page.getByRole('link', { name: 'Open the home page' }).click();
    assert.equal(await page.title(), 'byokit example');
    assert.equal(await page.evaluate(async () => (await fetch('missing.js')).status), 503);
    await context.close();
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    site.close();
  }
});
