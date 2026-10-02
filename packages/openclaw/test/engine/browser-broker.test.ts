// O19: actual published, package-lock-pinned Chromium; all pages, input and network are synthetic loopback fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { access, readFile, readdir, readlink, mkdtemp, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { randomInt, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { launchBroker, type Broker, type ViewerSession } from '../../src/browser/broker.ts';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const exists = async (path: string) => access(path).then(() => true, () => false);
const explicit = process.env.BYOKIT_TEST_CHROMIUM;
const expected = JSON.parse(await readFile(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8')).browsers.find((b: { name: string }) => b.name === 'chromium');
const executable = explicit ?? chromium.executablePath();
const available = await exists(executable);
const mustRun = !!process.env.CI || process.env.BYOKIT_BROWSER_REQUIRED === '1';
const marker = 'synthetic_broker_canary_7Q3e';

// Independent fixture decoder: Chromium emits baseline/progressive SOF. Do not reuse production sizing.
function encodedDimensions(jpeg: Uint8Array) {
  const bytes = Buffer.from(jpeg);
  for (let i = 2; i + 8 < bytes.length; i++) {
    if (bytes[i] === 0xff && [0xc0, 0xc1, 0xc2].includes(bytes[i + 1]!)) {
      return { w: bytes.readUInt16BE(i + 7), h: bytes.readUInt16BE(i + 5) };
    }
  }
  throw new Error('fixture JPEG has no encoded dimensions');
}
async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
// The pinned engine's discovery: strip Chromium's /devtools/browser/<id>, keep the query, append /json/<path>.
function discovery(endpoint: string, path: string) {
  const u = new URL(endpoint.replace(/^ws/, 'http'));
  u.pathname = `${u.pathname.replace(/\/devtools\/browser\/[A-Za-z0-9._-]+$/, '')}/json/${path}`;
  return u.href;
}
async function raw(url: string) {
  const ws = new WebSocket(url), frames: string[] = [], waiting = new Map<number, (value: any) => void>();
  let seq = 0;
  ws.on('message', data => {
    const text = data.toString(); frames.push(text);
    const message = JSON.parse(text);
    if (message.id !== undefined) { waiting.get(message.id)?.(message); waiting.delete(message.id); }
  });
  await once(ws, 'open');
  return { ws, frames, async send(method: string, params = {}, sessionId?: string): Promise<any> {
    const id = ++seq;
    const promise = new Promise(resolve => waiting.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params, sessionId })); return promise;
  } };
}
async function click(view: ViewerSession, x: number, y: number) {
  view.input({ kind: 'pointer', type: 'down', x, y, button: 'left' });
  view.input({ kind: 'pointer', type: 'up', x, y, button: 'left' });
  await new Promise(resolve => setTimeout(resolve, 30));
}
// Inspect only this Node's descendants, never another home's process or browser namespace.
async function children(pid: number): Promise<number[]> {
  const list = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');
  const ids = list.trim().split(/\s+/).filter(Boolean).map(Number);
  return [...ids, ...(await Promise.all(ids.map(children))).flat()];
}
async function live(pid: number) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  return stat !== '' && !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
}
async function listening(pid: number) {
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
  const links = await Promise.all(fds.map(fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')));
  const inodes = new Set(links.map(s => s.match(/^socket:\[(\d+)\]$/)?.[1]).filter(Boolean));
  let count = 0;
  for (const name of ['tcp', 'tcp6']) {
    const table = await readFile(`/proc/${pid}/net/${name}`, 'utf8').catch(() => '');
    for (const line of table.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && inodes.has(fields[9])) count++;
    }
  }
  return count;
}
async function secretHits(dir: string): Promise<number> {
  let hits = 0;
  const forms = [marker, encodeURIComponent(marker), Buffer.from(marker).toString('base64')].map(s => Buffer.from(s));
  forms.push(Buffer.from(marker, 'utf16le'));
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hits += await secretHits(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path); if (forms.some(s => bytes.includes(s))) hits++;
    }
  }
  return hits;
}

test('O19 pinned Chromium: pipe-only, isolated private controller, canary-zero, release and site clearing', {
  skip: !available && !mustRun ? 'explicit fixture Chromium not installed; required in engine CI' : false, timeout: 180_000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'broker-real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profileDir = join(dir, 'deep-profile-'.repeat(10), 'profile');
  let privateTemp: string | undefined;
  let path = executable;
  if (!available) {
    // CI can fetch only the official artifact for the package-lock pin, into this test's own directory.
    const browsers = process.env.BYOKIT_BROWSER_INSTALL_DIR ?? join(dir, 'browsers');
    const installed = await run(process.execPath, [join(dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium', '--no-shell'], {
      env: { HOME: dir, TMPDIR: dir, PLAYWRIGHT_BROWSERS_PATH: browsers }, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    t.diagnostic(installed.stdout.trim());
    const result = await run(process.execPath, ['--input-type=module', '-e', "import {chromium} from 'playwright'; console.log(chromium.executablePath())"], {
      env: { HOME: dir, TMPDIR: dir, PLAYWRIGHT_BROWSERS_PATH: browsers }, cwd: process.cwd(), timeout: 5000,
    });
    path = result.stdout.trim();
  }
  const version = (await run(path, ['--version'], { env: { HOME: dir, TMPDIR: dir }, timeout: 5000 })).stdout.trim();
  assert.ok(version.includes(expected.browserVersion), 'fixture must match published package-lock Chromium version');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  t.diagnostic(`fixture Chromium ${expected.browserVersion}; revision ${expected.revision}; executable ${path}; sha256 ${hash.digest('hex')}; package-lock Playwright pin`);
  // The owned fixture wrapper prevents Chromium background DNS/egress without changing the product's networking.
  const wrapper = join(dir, 'chromium-fixture');
  await writeFile(wrapper, `#!/bin/sh\nexec '${path.replaceAll("'", "'\\''")}' '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost' "$@"\n`);
  await chmod(wrapper, 0o700);
  // A task-owned nonzero X11 display, no inherited desktop/auth/environment, no TCP listener.
  const display = randomInt(2000, 30000);
  const x = spawn('/usr/bin/Xvfb', [`:${display}`, '-screen', '0', '1024x768x24', '-nolisten', 'tcp', '-noreset'], {
    env: { HOME: dir, TMPDIR: dir }, stdio: 'ignore',
  });
  x.on('error', () => {});
  t.after(async () => { if (x.pid && x.exitCode === null && x.signalCode === null) { x.kill('SIGTERM'); await once(x, 'exit'); } });
  let broker: Broker | undefined, chromePids: number[] = [], stage = 'setup';
  const posts: string[] = []; let downloads = 0, instrumented = 0;
  const idp = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (req.url === '/submit') {
      let body = ''; req.on('data', data => body += data); req.on('end', () => { posts.push(body); res.end('OK'); }); return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<form action="/submit" method="post"><input name="value" style="position:absolute;left:20px;top:20px;width:250px;height:35px"><button style="position:absolute;left:20px;top:80px;width:200px;height:40px">Submit</button></form>');
  });
  await new Promise<void>(resolve => idp.listen(0, '127.0.0.1', resolve));
  const idpOrigin = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  const site = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (req.url?.startsWith('/leak')) { instrumented++; res.end('ignored'); return; }
    if (req.url === '/download') { downloads++; res.setHeader('content-disposition', 'attachment; filename="fixture-download.txt"'); res.end('fixture download'); return; }
    if (req.url === '/session') {
      let body = ''; req.on('data', data => body += data); req.on('end', () => {
        posts.push(body); res.setHeader('set-cookie', 'fixture_auth=1; HttpOnly; SameSite=Lax; Path=/');
        res.writeHead(303, { location: '/ready' }); res.end();
      }); return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/anonymous-with-iframe') { res.writeHead(401); res.end('<iframe src="/ready"></iframe>'); return; }
    if (req.url === '/ready') {
      if (!req.headers.cookie?.includes('fixture_auth=1')) { res.writeHead(401); res.end('anonymous'); return; }
      res.end(`<div class="signedin">Signed in fixture</div><a href="/download" style="position:absolute;left:20px;top:20px;width:200px;height:40px">Download</a><button onclick="window.open('${idpOrigin}/idp')" style="position:absolute;left:20px;top:100px;width:200px;height:40px">Popup</button>`); return;
    }
    if (req.url === '/login') {
      res.end('<form action="/session" method="post"><input name="email" type="email" style="position:absolute;left:20px;top:20px;width:250px;height:35px"><input name="password" type="password" style="position:absolute;left:20px;top:80px;width:250px;height:35px"><input name="otp" style="position:absolute;left:20px;top:140px;width:250px;height:35px"><button style="position:absolute;left:20px;top:200px;width:200px;height:40px">Submit</button></form>'); return;
    }
    res.end('<title>Agent task</title><h1>Fixture task</h1>');
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const siteOrigin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  try {
    await until(() => exists(`/tmp/.X11-unix/X${display}`));
    assert.ok(display > 0); assert.equal(await listening(x.pid!), 0);
    broker = await launchBroker({ executablePath: wrapper, profileDir, member: 'fixture', onExit() {} });
    const owned = await children(process.pid);
    const mains = [];
    for (const pid of owned) {
      const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (cmd.includes(`--user-data-dir=${profileDir}`) && !cmd.includes('--type=')) mains.push(pid);
    }
    assert.equal(mains.length, 1, 'one owned Chromium main');
    const ownEnv = Object.fromEntries((await readFile(`/proc/${mains[0]}/environ`, 'utf8')).split('\0').filter(Boolean).map(s => { const at = s.indexOf('='); return [s.slice(0, at), s.slice(at + 1)]; }));
    privateTemp = ownEnv.TMPDIR;
    assert.equal(ownEnv.HOME, profileDir); assert.ok(profileDir.length > 108);
    assert.ok(privateTemp && privateTemp !== profileDir && privateTemp.startsWith(`${tmpdir()}/bk-`));
    assert.equal((await stat(privateTemp)).mode & 0o777, 0o700);
    assert.equal((await readlink(`/proc/${mains[0]}/fd/9`).catch(() => '')).includes('heavy-jobs.lock'), false);
    chromePids = [mains[0]!, ...await children(mains[0]!)];
    for (const pid of chromePids) assert.equal(await listening(pid), 0, 'Chromium exposes no TCP listener');
    assert.equal(await exists(join(profileDir, 'DevToolsActivePort')), false);
    const cmd = await readFile(`/proc/${mains[0]}/cmdline`, 'utf8');
    assert.ok(cmd.includes('--remote-debugging-pipe')); assert.ok(cmd.includes('BackForwardCache'));
    const endpoint = broker.endpoint().cdpUrl;
    assert.equal(new URL(endpoint).hostname, '127.0.0.1');
    assert.equal((await (await fetch(discovery(endpoint, 'version'))).json()).webSocketDebuggerUrl, endpoint);
    const listed = await (await fetch(discovery(endpoint, 'list'))).json() as { id: string; webSocketDebuggerUrl: string }[];
    assert.ok(listed.length > 0 && listed.every(t => new URL(t.webSocketDebuggerUrl).searchParams.get('token') === new URL(endpoint).searchParams.get('token')));
    assert.equal((await fetch(discovery(endpoint.replace(/\/devtools\/browser\/[^?]+/, '/devtools/browser'), 'list'))).status, 404); // the old bare path breaks engine discovery
    const browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0]!.pages()[0]!;
    await page.goto(`${siteOrigin}/task`);
    await page.addInitScript(() => { addEventListener('input', () => { void fetch('/leak'); }); });
    const root = await raw(endpoint), sibling = await raw(endpoint);
    const id = broker.agentTab()!;
    const sid = (await root.send('Target.attachToTarget', { targetId: id, flatten: true })).result.sessionId;
    await root.send('Network.enable', {}, sid); await root.send('Runtime.enable', {}, sid);
    assert.ok((await root.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(dir, 'downloads') })).result);
    await root.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const positive = await root.send('Runtime.evaluate', { expression: JSON.stringify(marker) }, sid);
    assert.equal(positive.result.result.value, marker);
    const view = broker.attachViewer({});
    const liveFrames = view.frames[Symbol.asyncIterator]();
    const seen = await liveFrames.next();
    assert.ok(!seen.done && seen.value.jpeg.byteLength > 100);
    assert.deepEqual(encodedDimensions(seen.value.jpeg), { w: seen.value.w, h: seen.value.h });
    const thumb = broker.attachViewer({ maxWidth: 320 });
    const small = await thumb.frames[Symbol.asyncIterator]().next();
    assert.ok(!small.done && small.value.w <= 320);
    assert.deepEqual(encodedDimensions(small.value.jpeg), { w: small.value.w, h: small.value.h });
    thumb.close();
    await page.evaluate(() => { document.body.style.backgroundColor = 'rgb(18, 50, 92)'; });
    let stillLive = await liveFrames.next();
    while (!stillLive.done && Buffer.from(stillLive.value.jpeg).equals(Buffer.from(seen.value.jpeg))) stillLive = await liveFrames.next();
    assert.ok(!stillLive.done); assert.equal(stillLive.value.w, seen.value.w);
    assert.deepEqual(encodedDimensions(stillLive.value.jpeg), { w: stillLive.value.w, h: stillLive.value.h });
    assert.throws(() => broker!.attachViewer({ maxWidth: 0 }));
    const baseline = root.frames.length;
    const received = new Promise<void>(resolve => {
      const listener = (data: WebSocket.RawData) => {
        if (data.toString().includes('fixture-inflight')) { root.ws.off('message', listener); resolve(); }
      };
      root.ws.on('message', listener);
    });
    const flight = root.send('Runtime.evaluate', { expression: `new Promise(r => { console.log('fixture-inflight'); setTimeout(() => r('${marker}'), 150); })`, awaitPromise: true }, sid);
    await received;
    const started = Date.now(); await broker.fence(true);
    assert.ok(Date.now() - started >= 100); assert.ok((await flight).error);
    await until(() => root.ws.readyState === WebSocket.CLOSED && sibling.ws.readyState === WebSocket.CLOSED);
    assert.equal((await liveFrames.next()).done, true);
    const lease = { epoch: 1, nonce: '0123456789abcdefghijklmnopqrstuv', origin: siteOrigin, knownIdps: [] };
    broker.bindLease(lease);
    const privateId = await broker.openPrivate(`${siteOrigin}/login`);
    await until(() => broker!.privateState()?.origin === siteOrigin);
    const denied = await raw(endpoint);
    for (const method of ['Target.getTargets', 'Target.attachToTarget', 'Target.setAutoAttach', 'Page.captureScreenshot',
      'Network.getAllCookies', 'Network.getResponseBody', 'DOM.getDocument', 'Runtime.evaluate', 'Input.insertText']) {
      assert.ok((await denied.send(method, { targetId: privateId, text: marker })).error, method);
    }
    assert.ok((await denied.send('Byokit.claimTakeover', { epoch: 0, nonce: lease.nonce })).error);
    assert.ok((await denied.send('Byokit.claimTakeover', { epoch: 1, nonce: 'wrong' })).error);
    const agentEnd = denied.frames.length;
    const control = broker.attachViewer({ lease, maxWidth: 320 });
    const controlled = await control.frames[Symbol.asyncIterator]().next();
    assert.ok(!controlled.done && controlled.value.w <= 320);
    assert.deepEqual(encodedDimensions(controlled.value.jpeg), { w: controlled.value.w, h: controlled.value.h });
    const sx = controlled.value.w / seen.value.w, sy = controlled.value.h / seen.value.h;
    const controlPoint = (x: number, y: number) => click(control, x * sx, y * sy);
    assert.throws(() => broker!.attachViewer({ lease }));
    assert.throws(() => broker!.attachViewer({}));
    await controlPoint(100, 35); control.input({ kind: 'text', text: `${marker}@fixture.test` });
    await controlPoint(100, 95); control.input({ kind: 'text', text: marker });
    await controlPoint(100, 155); control.input({ kind: 'text', text: marker });
    await controlPoint(100, 215);
    await until(() => posts.length === 1);
    assert.ok(posts[0]!.includes(marker), 'real form input positive control');
    // Reattach the same holder through the authenticated claim protocol. Navigation history is in
    // the closed controller set: it proves the redirect committed, unlike receipt of the form POST.
    control.close();
    assert.ok((await denied.send('Byokit.claimTakeover', lease)).result);
    let privateSid = (await denied.send('Target.attachToTarget', { targetId: privateId, flatten: true })).result.sessionId;
    for (const method of ['Runtime.evaluate', 'DOM.getDocument', 'Network.getAllCookies', 'Page.captureScreenshot']) {
      assert.ok((await denied.send(method, {}, privateSid)).error, `controller closed set: ${method}`);
    }
    assert.ok((await denied.send('Page.reload', { scriptToEvaluateOnLoad: 'globalThis.fixtureBypass=true' }, privateSid)).error);
    await until(async () => {
      const h = (await denied.send('Page.getNavigationHistory', {}, privateSid)).result;
      return h.entries[h.currentIndex].url === `${siteOrigin}/ready`;
    });
    const point = async (x: number, y: number) => {
      for (const type of ['mousePressed', 'mouseReleased']) assert.ok((await denied.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, privateSid)).result);
    };
    await point(100, 35); // authenticated /ready download link, browser-wide deny
    await until(() => downloads > 0);
    await until(() => broker!.privateState()?.origin === siteOrigin && !broker!.privateState()?.offOrigin);
    await point(100, 115); // held popup on distinct exact loopback origin
    await until(() => broker!.privateState()?.origin === idpOrigin);
    assert.equal(broker.privateState()!.offOrigin, true);
    const popup = (await denied.send('Byokit.claimTakeover', lease)).result.targetId;
    privateSid = (await denied.send('Target.attachToTarget', { targetId: popup, flatten: true })).result.sessionId;
    assert.ok((await denied.send('Input.insertText', { text: 'blocked-before-confirmation' }, privateSid)).error);
    assert.equal(broker.confirmOrigin(lease, siteOrigin), false);
    assert.equal(broker.confirmOrigin(lease, idpOrigin), true);
    await point(100, 35);
    assert.ok((await denied.send('Input.insertText', { text: 'confirmed-fixture' }, privateSid)).result);
    await point(100, 95); await until(() => posts.length === 2);
    assert.equal(posts[1], 'value=confirmed-fixture');
    assert.equal(instrumented, 0, 'instrumentation planted on agent tab did not see private input');
    assert.equal(root.frames.slice(baseline).filter(text => text.includes(marker) || text.includes(Buffer.from(marker).toString('base64'))).length, 0);
    assert.equal(denied.frames.slice(0, agentEnd).filter(text => text.includes(marker) || text.includes(privateId)).length, 0);
    assert.equal(await broker.probe(`${siteOrigin}/ready`, async p => p.status === 200 && await p.exists('.signedin'), 5000), 'ok');
    assert.equal(await broker.probe(`${siteOrigin}/anonymous-with-iframe`, async p => p.status === 200, 5000), 'fail');
    chromePids = [...new Set([...chromePids, ...await children(mains[0]!)])];
    for (const pid of chromePids) assert.equal(await listening(pid), 0, 'no debugging TCP listener during held state');
    stage = 'drop-lease'; broker.bindLease(null);
    assert.throws(() => broker!.attachViewer({ lease }));
    await assert.rejects(broker.fence(false));
    stage = 'close-private'; const closing = broker.closePrivate();
    assert.throws(() => broker!.bindLease({ ...lease, epoch: 2 }));
    await closing;
    assert.equal(broker.privateState(), undefined);
    stage = 'unfence'; await broker.fence(false);
    stage = 'navigate-agent'; await broker.navigateAgent('reload');
    stage = 'reattach'; const fresh = await chromium.connectOverCDP(endpoint);
    const pages = fresh.contexts()[0]!.pages();
    assert.equal(pages.length, 1); assert.ok(pages[0]!.url().endsWith('/task'));
    const cookies = await fresh.contexts()[0]!.cookies(); assert.ok(cookies.some(c => c.name === 'fixture_auth'));
    stage = 'clear-site';
    const scopeControl = await raw(endpoint);
    assert.ok((await scopeControl.send('Storage.clearDataForOrigin', { origin: siteOrigin, storageTypes: 'all' })).error, 'original root-domain failure reproduced on actual pinned Chromium');
    await broker.clearSite([siteOrigin]);
    assert.equal((await fresh.contexts()[0]!.cookies()).some(c => c.name === 'fixture_auth'), false);
    await fresh.close(); await browser.close().catch(() => {});
    assert.equal(await secretHits(privateTemp!), 0, 'no credential canary in owned private temp before cleanup');
    await broker.close(); broker = undefined;
    assert.equal(await exists(privateTemp!), false, 'only the broker-owned private temp is removed');
    await until(async () => !(await Promise.all(chromePids.map(live))).some(Boolean));
    assert.equal(await secretHits(profileDir), 0, 'no credential canary persisted in owned profile');
    assert.equal(await exists(join(dir, 'downloads', 'fixture-download.txt')), false);
    t.diagnostic('private canary hits: agent frames=0, profile=0, private temp=0/cleaned; long profile>108 and actual owned short temp=0700; positive controls: CDP, independently decoded JPEG<=320, simultaneous full live + thumbnail, scaled private input, submitted fixture form; Chromium TCP listeners=0');
  } finally {
    t.diagnostic(`fixture cleanup stage: ${stage}`);
    await broker?.close();
    if (chromePids.length) {
      await until(async () => !(await Promise.all(chromePids.map(live))).some(Boolean));
      t.diagnostic(`owned Chromium cleanup: ${chromePids.length} recorded processes no longer live`);
    }
    site.closeAllConnections(); idp.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => site.close(() => resolve())), new Promise<void>(resolve => idp.close(() => resolve()))]);
    if (x.exitCode === null && x.signalCode === null) { x.kill('SIGTERM'); await once(x, 'exit'); }
    await rm(dir, { recursive: true, force: true });
  }
});
