// The pairing example, against a loopback-only host with no model or account.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { Host, keyPair, encodeOffer, parseV1Offer } from '../../packages/pair/src/index.ts';
import { serve } from './serve.ts';

const site = await serve();
const executablePath = existsSync(chromium.executablePath()) ? undefined : process.env.BYOKIT_CHROME ?? '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath });
const host = await Host.open({ keys: keyPair(), name: 'Kitchen computer',
  confirm: ({ role, kind }) => role === 'view' && kind === 'browser',
  canView: (r) => r.op === 'get.summary', handle: () => ({ text: 'Ready to read.' }),
});
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>((r) => wss.once('listening', r));
wss.on('connection', (ws) => host.accept(ws));
const urls = [`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/link`];
after(async () => { await browser.close(); host.close(); wss.close(); site.close(); });

test('browser deep link pairs view-only, reads and retains its sealed grant across reload', { timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const offer = host.offer({ role: 'view', kind: 'browser', lifetime: 60_000, urls, base: site.url + 'pair.html' });
  await page.goto(offer.text);
  assert.equal(new URL(page.url()).hash, '', 'ticket cleared from address bar');
  await page.click('#connect');
  await page.locator('#status').filter({ hasText: 'Your computer is connected.' }).waitFor();
  assert.equal(host.devices()[0].role, 'view');
  await page.click('#read');
  await page.locator('#answer').filter({ hasText: 'Ready to read.' }).waitFor();
  await page.reload();
  await page.locator('#status').filter({ hasText: 'Your computer is connected.' }).waitFor();
  assert.equal(await page.locator('#pair').isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('pasted offline envelope pairs, expired and control offers are refused before pairing', { timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(site.url + 'pair.html');
  const control = host.offer({ role: 'control', urls });
  await page.fill('#offer', control.text);
  await page.click('#connect');
  await page.locator('#status').filter({ hasText: 'Ask your computer for an invitation to read here.' }).waitFor();
  const text = host.offer({ role: 'view', kind: 'browser', urls }).text;
  const offer = parseV1Offer(text);
  await page.fill('#offer', encodeOffer({ ...offer, expires: 1 }));
  await page.click('#connect');
  await page.locator('#status').filter({ hasText: 'run out' }).waitFor();
  await page.fill('#offer', encodeOffer(offer));
  await page.click('#connect');
  await page.locator('#status').filter({ hasText: 'Your computer is connected.' }).waitFor();
  await context.close();
});
