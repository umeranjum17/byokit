// Where a device keeps its grant, by checklist row: K3 the phone's secure storage (a real pairing, kept, then used
// again after a restart), K4 the browser's IndexedDB sealed by a non-extractable AES-GCM key (in Chromium), and a
// computer's file sealed with Electron's safeStorage.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { DeviceLink, Host, keyPair, pairWithOffer, secureDeviceStore, type SecureStoreLike } from '../src/index.ts';
import { fileDeviceStore } from '../src/node.ts';

const host = await Host.open({ keys: keyPair(), name: 'Kitchen computer', confirm: () => true, handle: (r) => ({ op: r.op }) });
const server = createServer();
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => host.accept(ws));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
after(() => { host.close(); wss.close(); server.close(); });
const pair = () => pairWithOffer(host.offer({ role: 'control', urls: [url] }).text, { name: 'Phone', onWords: () => {} });

test('K3: the grant in expo-secure-store, one small value; after a restart the device connects from it', async () => {
  const kept = new Map<string, string>();
  const secure: SecureStoreLike = {
    getItemAsync: async (k) => kept.get(k) ?? null,
    setItemAsync: async (k, v) => { assert.match(k, /^[\w.-]+$/); assert.ok(v.length < 2048, 'under the size expo-secure-store allows'); kept.set(k, v); },
    deleteItemAsync: async (k) => { kept.delete(k); },
  };
  const store = secureDeviceStore(secure, 'byokit.link.kitchen');
  assert.equal(await store.load(), null);
  await store.save(await pair());
  const restarted = await secureDeviceStore(secure, 'byokit.link.kitchen').load();
  assert.ok(restarted);
  const link = new DeviceLink(restarted, { store });
  try { assert.deepEqual(await link.request('get.state'), { op: 'get.state' }); } finally { link.stop(); }
  await store.clear();
  assert.equal(await store.load(), null);
});

// Playwright's own Chromium where installed; else the system's (GitHub's runners have Chrome).
const chrome = existsSync(chromium.executablePath()) ? undefined
  : [process.env.BYOKIT_CHROME, '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
test('K4: the grant in IndexedDB, sealed by a non-extractable AES-GCM key; the stored record reveals nothing', async () => {
    const grant = await pair();
    const js = (await build({ entryPoints: [new URL('../src/stores.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false })).outputFiles[0].text;
    const site = createServer((req, res) => {
      if (req.url === '/stores.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>k4</title>');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ executablePath: chrome });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
      const r = await page.evaluate(async (g) => {
        const { browserDeviceStore } = await import('/stores.js' as string);
        const store = browserDeviceStore('kitchen');
        const other = { ...g, host: g.host + '-second' };
        const generate = crypto.subtle.generateKey.bind(crypto.subtle);
        let arrived = 0;
        let release!: () => void;
        const both = new Promise<void>((resolve) => { release = resolve; });
        Object.defineProperty(crypto.subtle, 'generateKey', { configurable: true, value: async (...args: Parameters<typeof generate>) => {
          const key = await generate(...args);
          if (++arrived === 2) release();
          await both;
          return key;
        } });
        await Promise.all([store.save(g), browserDeviceStore('kitchen').save(other)]);
        const back = await browserDeviceStore('kitchen').load();
        const raw = await new Promise<any>((resolve) => {
          const o = indexedDB.open('byokit-link');
          o.onsuccess = () => {
            const t = o.result.transaction(['grants', 'keys']);
            const grant = t.objectStore('grants').get('kitchen');
            const key = t.objectStore('keys').get('kitchen');
            t.oncomplete = () => resolve({ grant: grant.result, key: key.result });
          };
        });
        const exported = await crypto.subtle.exportKey('raw', raw.key).then(() => 'exported', () => 'refused');
        const stored = new TextDecoder('latin1').decode(new Uint8Array(raw.grant.data));
        await store.clear();
        return { back, arrived, extractable: raw.key.extractable, exported, leaks: stored.includes(g.secretKey) || stored.includes('Kitchen'), cleared: await store.load() };
      }, grant);
      assert.equal(r.arrived, 2, 'both first saves generated a key');
      assert.ok(r.back.host === grant.host || r.back.host === grant.host + '-second');
      assert.equal(r.back.secretKey, grant.secretKey);
      assert.equal(r.extractable, false);
      assert.equal(r.exported, 'refused');
      assert.equal(r.leaks, false);
      assert.equal(r.cleared, null);
    } finally { await browser.close(); site.close(); }
  });

test("a computer's grant: a 0600 file, sealed with Electron's safeStorage when given", async () => {
  const grant = await pair();
  const path = join(mkdtempSync(join(tmpdir(), 'byokit-link-')), 'device', 'grant');
  const safeStorage = {
    encryptString: (text: string) => Buffer.from([...Buffer.from(text)].map((b) => b ^ 0x5a)),
    decryptString: (data: Buffer) => Buffer.from([...data].map((b) => b ^ 0x5a)).toString(),
  };
  const store = fileDeviceStore(path, safeStorage);
  await store.save(grant);
  assert.ok(!readFileSync(path, 'latin1').includes(grant.secretKey));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(await fileDeviceStore(path, safeStorage).load(), grant);
  await store.clear();
  assert.equal(await store.load(), null);
});
