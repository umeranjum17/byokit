// A real browser as a device: the client bundled for the web (so nothing from Node can sneak in), in headless
// Chromium, pairing from a link and making requests against a real host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scratchDir, trackChild } from '../../test-support.ts';
import { join } from 'node:path';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { Host, b64url, keyPair, type PairRequest } from '../src/index.ts';
import { allowedMilestones } from './browser/milestones.ts';

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
  const started = Date.now();
  const trace: string[] = [];
  const note = (step: string) => {
    if (trace.length === 64) trace.shift();
    trace.push(`${Date.now() - started}ms ${step}`);
  };

  const asked: PairRequest[] = [];
  let report: (r: any) => void, failed: (e: Error) => void;
  const reported = new Promise<any>((r, no) => { report = r; failed = no; });
  const host = await Host.open({
    keys: keyPair(), name: 'Kitchen computer',
    confirm: (p) => { note('host approval'); asked.push(p); return true; },
    onConnection: (_, online) => note(online ? 'host device online' : 'host device offline'),
    canView: (r) => r.op === 'get.state' || r.op === 'report',
    handle: (r) => { note(r.op === 'report' ? 'host report' : 'host state request'); if (r.op === 'report') report(r.args); return { ok: 1 }; },
  });
  const { code } = host.shortCode({ role: 'view' });
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/milestone/')) {
      const step = req.url.slice('/milestone/'.length);
      if (allowedMilestones.has(step)) note(step);
      req.resume();
      return res.writeHead(204).end();
    }
    if (req.url === '/failed') {
      note('page reported failure (details redacted)');
      req.on('end', () => failed(new Error('the page failed (details redacted)')));
      req.resume();
      return res.writeHead(204).end();
    }
    if (req.url === '/client.js') {
      note('module served');
      return res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    }
    if (req.url === '/pair') note('page served');
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>pairing</title><meta name="short-code" content="${code}"><script>fetch('/milestone/page-loaded', {method: 'POST'}).catch(() => {})</script><script type="module" src="/client.js" onload="fetch('/milestone/module-loaded', {method: 'POST'}).catch(() => {})" onerror="fetch('/milestone/module-error', {method: 'POST'}).catch(() => {})"></script>`);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    note('socket open');
    ws.on('close', (code) => note(`socket close ${code}`));
    host.accept(ws);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { text } = host.offer({ role: 'view', urls: [base.replace('http', 'ws') + '/link'], base: `${base}/pair` });
  assert.match(text, /^http:\/\/127\.0\.0\.1:\d+\/pair#byokit-link:1:/);

  const profile = scratchDir('chrome');
  // Safe launch shapes only: no path, pairing fragment, environment value or raw Chrome stderr.
  note(`browser candidate ${['chromium', 'google-chrome', 'google-chrome-stable', 'chromium-browser'].includes(chrome!) ? chrome : 'override'}`);
  note(`path lengths HOME=${process.env.HOME?.length ?? 0} TMPDIR=${process.env.TMPDIR?.length ?? 0} profile=${profile.length}`);
  note(`environment presence DISPLAY=${!!process.env.DISPLAY} DBUS=${!!process.env.DBUS_SESSION_BUS_ADDRESS} XDG_RUNTIME=${!!process.env.XDG_RUNTIME_DIR}`);
  const stderrKinds = new Set<string>();
  note('browser launch');
  const browser = trackChild(spawn(chrome!, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-default-browser-check', text], { stdio: ['ignore', 'ignore', 'pipe'], detached: true }));
  const exited = new Promise<void>((r) => browser.once('close', () => r()));
  browser.once('spawn', () => note('browser spawned'));
  browser.once('error', () => { note('browser spawn error (details redacted)'); failed(new Error('the browser could not start')); });
  browser.once('exit', (code, signal) => note(`browser exit ${code} signal ${signal}`));
  let stderrBytes = 0;
  browser.stderr!.on('data', (d: Buffer) => {
    if (!stderrBytes) note('browser stderr received (content redacted)');
    stderrBytes += d.length; // Chrome can echo the pairing fragment in its process name; never retain its text.
    const text = d.toString('utf8'); // ephemeral; persist only fixed, non-sensitive error categories
    for (const [kind, pattern] of [
      ['singleton-socket', /Socket path too long|File name too long|Failed to create a ProcessSingleton/],
      ['profile-in-use', /profile appears to be in use/],
      ['snap-launch', /requires the chromium snap|snap-confine|cannot create user data directory/],
      ['sandbox', /No usable sandbox|Failed to move to new namespace/],
      ['shared-library', /error while loading shared libraries/],
      ['process-crash', /Trace\/breakpoint trap|Segmentation fault/],
      ['devtools', /DevTools listening/],
    ] as const) if (pattern.test(text)) stderrKinds.add(kind);
  });
  try {
    let timer: any;
    const r = await Promise.race([reported, new Promise((_, no) => { timer = setTimeout(() => no(new Error('the browser never reported')), 60_000); })])
      .finally(() => clearTimeout(timer)) as any;
    assert.equal(asked.length, 2);
    assert.equal(asked[0].name, 'Browser tab');
    assert.equal(r.words, asked[0].words, 'the page showed the same two words');
    assert.deepEqual(r.state, { ok: 1 });
    assert.equal(r.role, 'view');
    assert.equal(r.shortWords, asked[1].words);
    assert.deepEqual(r.shortState, { ok: 1 });
    assert.equal(r.shortHost, b64url(host.keys.publicKey));
    assert.deepEqual(host.devices().map((d) => [d.name, d.online]), [['Browser tab', true], ['Umer’s browser', true]]);
  } catch (e) {
    console.error(`browser diagnostics (observed arrival times):\n${trace.join('\n')}\nstderr bytes: ${stderrBytes} (content redacted)\nstderr categories: ${[...stderrKinds].join(',') || 'unclassified'}`);
    throw e;
  } finally {
    try { process.kill(-browser.pid!, 'SIGKILL'); } catch {} // the whole group: Chrome's helpers outlive the main process
    host.close(); wss.close(); server.close();
    await exited;
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} // ponytail: a stray helper may still hold it; it is in tmp
  }
});
