// A real browser as a device: the client bundled for the web (so nothing from Node can sneak in), in headless
// Chromium, pairing from a link and making requests against a real host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { Host, keyPair, type PairRequest } from '../src/index.ts';

const chrome = [process.env.BYOKIT_CHROME, 'chromium', 'google-chrome', 'google-chrome-stable', 'chromium-browser']
  .find((c) => c && spawnSync('which', [c]).status === 0);

const web = build({
  entryPoints: [join(import.meta.dirname, 'browser', 'client.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
});

test('the device side bundles for the web with nothing from Node', async () => {
  assert.equal((await web).errors.length, 0); // esbuild refuses any Node built-in when bundling for a browser
});

test('a browser pairs from a link and uses the link', { skip: !chrome && !process.env.CI && 'no Chrome or Chromium here' }, async () => {
  assert.ok(chrome, 'CI needs Chrome for this test');
  const js = (await web).outputFiles[0].text;

  const asked: PairRequest[] = [];
  let report: (r: any) => void;
  const reported = new Promise<any>((r) => { report = r; });
  const host = await Host.open({
    keys: keyPair(), name: 'Kitchen computer',
    confirm: (p) => { asked.push(p); return true; },
    canView: (r) => r.op === 'get.state' || r.op === 'report',
    handle: (r) => { if (r.op === 'report') report(r.args); return { ok: 1 }; },
  });
  const server = createServer((req, res) => {
    if (req.url === '/client.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>pairing</title><script type="module" src="/client.js"></script>');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => host.accept(ws));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { text } = host.offer({ role: 'view', urls: [base.replace('http', 'ws') + '/link'], base: `${base}/pair` });
  assert.match(text, /^http:\/\/127\.0\.0\.1:\d+\/pair#byokit-link:1:/);

  const profile = mkdtempSync(join(tmpdir(), 'byokit-chrome-'));
  const browser = spawn(chrome!, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-default-browser-check', text], { stdio: 'ignore', detached: true });
  try {
    let timer: any;
    const r = await Promise.race([reported, new Promise((_, no) => { timer = setTimeout(() => no(new Error('the browser never reported')), 30_000); })])
      .finally(() => clearTimeout(timer)) as any;
    assert.equal(asked.length, 1);
    assert.equal(asked[0].name, 'Browser tab');
    assert.equal(r.words, asked[0].words, 'the page showed the same two words');
    assert.deepEqual(r.state, { ok: 1 });
    assert.equal(r.role, 'view');
    assert.deepEqual(host.devices().map((d) => [d.name, d.online]), [['Browser tab', true]]);
  } finally {
    const exited = browser.exitCode !== null || new Promise((r) => browser.once('exit', r));
    try { process.kill(-browser.pid!, 'SIGKILL'); } catch {} // the whole group: Chrome's helpers outlive the main process
    host.close(); wss.close(); server.close();
    await exited;
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} // ponytail: a stray helper may still hold it; it is in tmp
  }
});
