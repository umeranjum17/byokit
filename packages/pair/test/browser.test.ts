// A real browser as a device: the client bundled for the web (so nothing from Node can sneak in), in headless
// Chromium, pairing from a link and making requests against a real host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadavg } from 'node:os';
import { scratchDir, trackChild } from '../../test-support.ts';
import { join } from 'node:path';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { Host, b64url, keyPair, type PairRequest } from '../src/index.ts';
import { allowedMilestones } from './browser/milestones.ts';
import { ownedBrowser, testBrowserBinary } from './browser/owned-browser.ts';

// One documented key (BYOKIT_CHROME) selects the browser; unset, the first Chromium on PATH is used.
const chrome = testBrowserBinary();

const web = build({
  entryPoints: [join(import.meta.dirname, 'browser', 'client.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
});

test('the device side bundles for the web with nothing from Node', async () => {
  assert.equal((await web).errors.length, 0); // esbuild refuses any Node built-in when bundling for a browser
});

// Where the runner is short of CPU, memory or disk right now (Linux pressure stall averages), so a slow start names its cause.
const pressure = () => [`load ${loadavg().map((l) => l.toFixed(2)).join(' ')}`, ...['cpu', 'io', 'memory'].map((k) => {
  try { return `${k}: ${readFileSync(`/proc/pressure/${k}`, 'utf8').trim().replace(/\n/g, ' | ')}`; } catch { return `${k}: unavailable`; }
})].join('\n');

test('a browser pairs from a link and uses the link', { skip: !chrome && !process.env.CI && 'no Chrome or Chromium here' }, async (t) => {
  assert.ok(chrome, 'CI needs Chrome for this test');
  const js = (await web).outputFiles[0].text;
  const started = Date.now();
  const trace: string[] = [];
  const note = (step: string) => {
    if (trace.length === 64) trace.shift();
    trace.push(`${Date.now() - started}ms ${step}`);
  };

  const asked: PairRequest[] = [];
  let report: (r: any) => void, failed: (e: Error) => void, pageRequested: () => void;
  const reported = new Promise<any>((r, no) => { report = r; failed = no; });
  const pageAsked = new Promise<void>((r) => { pageRequested = r; });
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
    if (req.url === '/pair') { note('page served'); pageRequested(); }
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
  // Chrome can echo the pairing link (or a truncated prefix of it) in its own log; every copy kept or printed is scrubbed.
  const scrub = (s: string) => s.replaceAll(code, '<short-code>').replace(/#[^\s"'\]]*/g, '#<fragment>').replace(/byokit-link:\S*/g, '<link>');
  let binary = chrome!;
  try { binary = realpathSync((spawnSync('which', [chrome!], { encoding: 'utf8' }).stdout ?? '').trim()); } catch {}
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-default-browser-check',
    '--enable-logging=stderr', '--v=1', text]; // --v=1: Chrome's own timestamped launch log, so a slow start shows where it stalls
  const atLaunch = pressure();
  note(`browser ${binary}`);
  note(`path lengths HOME=${process.env.HOME?.length ?? 0} TMPDIR=${process.env.TMPDIR?.length ?? 0} profile=${profile.length}`);
  note(`environment presence DISPLAY=${!!process.env.DISPLAY} DBUS=${!!process.env.DBUS_SESSION_BUS_ADDRESS} XDG_RUNTIME=${!!process.env.XDG_RUNTIME_DIR}`);
  note('browser launch');
  const owned = ownedBrowser(chrome!, args, profile);
  const browser = trackChild(owned.chrome);
  const exited = new Promise<void>((r) => browser.once('close', () => r()));
  browser.once('spawn', () => note('browser spawned'));
  browser.once('error', (e) => { note('browser spawn error'); failed(new Error(`the browser could not start: ${e.message}`)); });
  // A browser that is gone can never report: stop waiting the moment it exits instead of sitting out the deadline.
  browser.once('exit', (code, signal) => { note(`browser exit ${code} signal ${signal}`); failed(new Error(`the browser exited (code ${code}, signal ${signal}) before reporting`)); });
  let stderr = '';
  browser.stderr!.on('data', (d: Buffer) => {
    if (!stderr) note('browser stderr received');
    stderr += d.toString('utf8');
  });
  let failure: unknown;
  const within = <T>(ms: number, what: string, p: Promise<T>) => {
    let timer: any;
    return Promise.race([p, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`${what}: after ${ms}ms the last step was "${trace.at(-1)?.replace(/^\d+ms /, '')}"`)), ms); })])
      .finally(() => clearTimeout(timer));
  };
  try {
    // Starting the browser is not the test: the first Chrome on a fresh CI runner has taken 2-53s (once over 60s) just
    // to ask for the page, while every later launch in the same job takes 1-2s. It gets its own limit and message, and
    // the 60s pairing clock starts when the page is requested.
    await within(180_000, 'the browser never asked for the page', Promise.race([pageAsked, reported]));
    const pairing = Date.now();
    const r = await within(60_000, 'the browser never reported', reported);
    t.diagnostic(`browser start ${pairing - started}ms (not timed), pairing ${Date.now() - pairing}ms (60s limit)`);
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
    failure = e;
    throw e;
  } finally {
    // Close exactly the processes this helper spawned over their own CDP pipe; never a process group.
    let cleanupError: unknown;
    try { await owned.close(); } catch (error) { cleanupError = error; }
    host.close(); wss.close(); server.close();
    await exited; // after this the browser's stderr is complete
    if (failure) console.error(`browser diagnostics (observed arrival times):\n${trace.join('\n')}\nbrowser stderr, last 40 lines:\n${scrub(stderr).trimEnd().split('\n').slice(-40).join('\n')}`);
    if (cleanupError) console.error(`browser cleanup failed: ${String(cleanupError)}`);
    t.diagnostic(`browser timeline: ${trace.filter((l) => /launch|spawned|stderr|served|report|exit/.test(l)).join(', ')}`);
    // The whole account next to the test result; CI keeps it as an artifact.
    if (process.env.BYOKIT_DIAGNOSTICS) {
      mkdirSync(process.env.BYOKIT_DIAGNOSTICS, { recursive: true });
      writeFileSync(join(process.env.BYOKIT_DIAGNOSTICS, 'link-browser.log'), scrub([
        `binary: ${binary}`, `args: ${args.join(' ')}`, `node: ${process.version}`,
        `pressure at launch:\n${atLaunch}`, `pressure at end:\n${pressure()}`,
        `trace (ms since the test started):\n${trace.join('\n')}`, `browser stderr (${stderr.length} bytes):\n${stderr}`,
      ].join('\n\n')));
    }
    // A failed close keeps its cleanup-failure.json receipt (skip the stray-profile cleanup); a real
    // close already removed the profile. Never mask the journey's own failure with the cleanup error.
    if (!cleanupError) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} }
    if (cleanupError && !failure) throw cleanupError;
  }
});
